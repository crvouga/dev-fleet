"""Opt-in real Ubuntu/systemd test in a disposable QEMU guest, not live acceptance.
Build test tooling with the adjacent Dockerfile. Run with /dev/kvm, repository
mounted read-only at /workspace and an empty temporary directory at /artifacts.
No host networking, host root mount, Docker socket or production secrets allowed.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import tomllib
import urllib.request

ROOT = Path('/artifacts')
BOOTSTRAP = Path('/bootstrap/revision').exists()
# The desktop session needs a desktop installed in the guest: several GiB and
# a graphical login on QEMU's virtual display. Opt in with FLEET_TEST_DESKTOP=1.
DESKTOP = os.environ.get('FLEET_TEST_DESKTOP') == '1'
HOME = '/home/fleettest'
SERVER = 't3code-headless.service'
APP = 't3code-desktop.service'
IMAGE_SHA = '5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5'


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=600, **kwargs)
    if result.returncode:
        (ROOT / 'last-failure.log').write_text(result.stdout + result.stderr)
        raise RuntimeError('Disposable VM command failed; inspect private artifact last-failure.log')
    return result


def main():
    ROOT.mkdir(exist_ok=True)
    image = ROOT / 'ubuntu.img'
    if not image.exists():
        with urllib.request.urlopen('https://cloud-images.ubuntu.com/releases/resolute/release-20261016/ubuntu-26.04-server-cloudimg-amd64.img', timeout=60) as response, image.open('wb') as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
    assert hashlib.file_digest(image.open('rb'), 'sha256').hexdigest() == IMAGE_SHA
    print('verified Ubuntu cloud image', flush=True)
    if not (ROOT / 'client').exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ROOT / 'client')])
    if not (ROOT / 'host').exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ROOT / 'host')])
    private = '\n'.join('    ' + line for line in (ROOT / 'host').read_text().splitlines())
    public = (ROOT / 'host.pub').read_text().strip()
    (ROOT / 'known_hosts').write_text('[127.0.0.1]:2222 ' + public + '\n')
    (ROOT / 'user-data').write_text(f'''#cloud-config
users:
  - name: fleettest
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - {(ROOT / 'client.pub').read_text().strip()}
ssh_keys:
  ed25519_private: |
{private}
  ed25519_public: {public}
{"" if BOOTSTRAP else "packages: [ansible-core]"}
''')
    (ROOT / 'meta-data').write_text('instance-id: disposable-fleet-test\nlocal-hostname: disposable-fleet-test\n')
    run(['cloud-localds', str(ROOT / 'seed.img'), str(ROOT / 'user-data'), str(ROOT / 'meta-data')])
    if not (ROOT / 'guest.qcow2').exists():
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(ROOT / 'guest.qcow2'), '64G' if BOOTSTRAP else '24G'])
    ssh = ['ssh', '-i', str(ROOT / 'client'), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={ROOT}/known_hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', '2222', 'fleettest@127.0.0.1']
    log = (ROOT / 'serial.log').open('w')
    vm = subprocess.Popen(['qemu-system-x86_64', '-enable-kvm', '-cpu', 'host', '-smp', '2', '-m', '4096', '-display', 'none', '-serial', 'stdio', '-drive', f'file={ROOT}/guest.qcow2,if=virtio', '-drive', f'file={ROOT}/seed.img,format=raw,if=virtio', '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22', '-device', 'virtio-net-pci,netdev=net0'], stdout=log, stderr=log)
    try:
        for _ in range(120):
            attempt = subprocess.run(ssh + ['true'], capture_output=True, timeout=5)
            if attempt.returncode == 0:
                break
            time.sleep(2)
        run(ssh + ['cloud-init status --wait --long'])
        print('fresh verified SSH and cloud-init complete', flush=True)
        if BOOTSTRAP:
            # The official cloud image includes Git. Remove it only in this
            # disposable fixture to exercise the minimal-target boundary.
            run(ssh + ['sudo apt-get remove --yes git'])
            run(ssh + ['! command -v node && ! command -v bun && ! command -v mise && ! command -v git'])
            print('fresh target has no Node, Bun, mise or Git; invoking production SSH bootstrap', flush=True)
            run(ssh + ['mkdir -p work && printf preserved > work/uncommitted'])
            result = subprocess.run(['/verification/bootstrap', str(ROOT), '/bootstrap'], capture_output=True, text=True, timeout=5500)
            (ROOT / 'bootstrap-result.json').write_text(result.stdout)
            assert result.returncode == 0, 'production bootstrap did not reach node convergence; inspect redacted bootstrap-result.json'
            evidence = 'sha256sum work/uncommitted /etc/ssh/ssh_host_ed25519_key.pub; stat -c %Y /etc/systemd/logind.conf.d/60-personal-fleet.conf /etc/ssh/sshd_config.d/60-personal-fleet.conf'
            before = run(ssh + [evidence]).stdout
            repeated = subprocess.run(['/verification/bootstrap', str(ROOT), '/bootstrap'], capture_output=True, text=True, timeout=5500)
            (ROOT / 'bootstrap-repeat-result.json').write_text(repeated.stdout)
            assert repeated.returncode == 0, 'repeated bootstrap did not pass the baseline'
            assert run(ssh + [evidence]).stdout == before, 'repeat changed work, SSH identity or unchanged managed files'
            print('production remote bootstrap and repeat passed the baseline; live auth remains unverified', flush=True)
            return
        verification = Path('/verification/verify')
        assert verification.exists(), 'Compile the tracked runtime-check.ts fixture and mount /verification first'
        subprocess.run(ssh + ['cat > verify && chmod 700 verify'], input=verification.read_bytes(), capture_output=True, check=True, timeout=60)
        run(ssh + ['mkdir -p baseline && mkdir -p work && printf preserved > work/uncommitted'])
        archive = subprocess.run(['tar', '-C', '/workspace/ansible/ubuntu', '-cf', '-', '.'], capture_output=True, check=True).stdout
        subprocess.run(ssh + ['tar -C baseline -xf -'], input=archive, capture_output=True, check=True)
        command = 'cd baseline && ansible-playbook baseline.yml --extra-vars \'{"development_user":"fleettest","development_uid":1000,"development_home":"/home/fleettest","tailscale_address":"100.64.0.2","ssh_port":22}\''
        first = run(ssh + [command])
        (ROOT / 'first-apply.log').write_text(first.stdout + first.stderr)
        second = run(ssh + [command])
        (ROOT / 'repeat-apply.log').write_text(second.stdout + second.stderr)
        assert 'changed=0' in second.stdout, 'repeat run changed configuration'
        test_drift(ssh, command)
        run(ssh + ['test "$(cat work/uncommitted)" = preserved && sudo visudo -c && test "$(systemctl is-enabled sleep.target)" = masked'])
        t3 = test_headless(ssh)
        test_agent(ssh)
        reboot(ssh)
        run(ssh + ['test "$(systemctl is-enabled sleep.target)" = masked && test "$(cat work/uncommitted)" = preserved'])
        if t3:
            after_headless_reboot(ssh, t3)
            if DESKTOP:
                test_desktop(ssh, t3)
        verification = Path('/verification/verify')
        if verification.exists():
            subprocess.run(ssh + ['cat > verify && chmod 700 verify'], input=verification.read_bytes(), capture_output=True, check=True, timeout=60)
            evidence = run(ssh + ['./verify'])
            (ROOT / 'boot-policy-evidence.json').write_text(evidence.stdout)
            print('production boot-policy observer passed after VM reboot', flush=True)
        run(ssh + ['systemctl is-active beszel-agent.service && test \"$(sudo cat /var/lib/beszel-agent/fixture-preserved)\" = preserved'])
        print(json.dumps({'passed': ['Ubuntu baseline apply', 'repeat no-op', 'sudoers validation', 'sleep target masked', 'reboot and fresh SSH', 'uncommitted file preserved', 'sleep/SSH drift repair and injected capacity gate', 'native Beszel agent no-op/crash/reboot with intentionally unreachable fixture hub'] + (['headless T3 server: install, no-op, killed process restarted, stopped server started by the recovery timer, started at boot with nobody logged in, managed update policy'] if t3 else []) + (['desktop T3 app: switch from headless keeping ~/.t3, auto-login after reboot, stopped app started by the recovery timer'] if t3 and DESKTOP else []), 'unverified': ['Tailscale', 'paired T3', 'Beszel agent/private metrics', 'full remote bootstrap'] + ([] if DESKTOP else ['desktop session (FLEET_TEST_DESKTOP=1)'])}), flush=True)
    finally:
        # Preserve failure evidence on disk before terminating the disposable VM.
        # This is fixture cleanup, not a claimed power-loss acceptance test.
        try:
            subprocess.run(ssh + ['sync'], capture_output=True, timeout=15)
        except subprocess.TimeoutExpired:
            pass
        vm.terminate()
        try:
            vm.wait(timeout=15)
        except subprocess.TimeoutExpired:
            vm.kill()
            vm.wait()
        log.close()


def pins():
    """The T3 release mise.toml pins, with its digests: never written here."""
    with open('/workspace/mise.toml', 'rb') as source:
        variables = tomllib.load(source)['vars']
    return variables['t3_version'], variables['t3_linux_x64_sha256'], variables['t3_desktop_amd64_sha256']


def download(url, target, digest):
    if not target.exists():
        with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
    assert hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == digest, f'{target.name} does not match its pin'


def variables(**extra):
    return json.dumps({'development_user': 'fleettest', 'development_uid': 1000, 'development_home': HOME, 'development_source': f'{HOME}/source', **extra})


def play(ssh, playbook, **extra):
    return run(ssh + [f"cd baseline && ansible-playbook {playbook} --extra-vars '{variables(**extra)}'"])


def user(ssh, command):
    return run(ssh + [f'XDG_RUNTIME_DIR=/run/user/1000 {command}'])


def main_pid(ssh, unit):
    return user(ssh, f'systemctl --user show {unit} -p MainPID --value').stdout.strip()


def wait_for(ssh, command, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if subprocess.run(ssh + [command], capture_output=True, timeout=20).returncode == 0:
            return time.monotonic() - (deadline - seconds)
        time.sleep(5)
    raise AssertionError(message)


def answers(unit):
    return f'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet {unit} && curl --fail --silent --max-time 10 http://127.0.0.1:3773/.well-known/t3/environment | grep -q environmentId'


def reboot(ssh):
    boot = run(ssh + ['cat /proc/sys/kernel/random/boot_id']).stdout
    subprocess.run(ssh + ['sudo reboot'], capture_output=True, timeout=10)
    time.sleep(3)
    for _ in range(120):
        result = subprocess.run(ssh + ['cat /proc/sys/kernel/random/boot_id'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout != boot:
            break
        time.sleep(2)
    assert result.returncode == 0 and result.stdout != boot, 'reboot reconnect failed'


def test_headless(ssh):
    """A headless worker on a stock server image: the pinned T3 server as a
    lingering user service (t3-headless.yml), recovered by the timer."""
    version, server_sha, _ = pins()
    name = f't3-{version}-linux-x64'
    archive = ROOT / f'{name}.tar.gz'
    download(f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}.tar.gz', archive, server_sha)
    tools = f'{HOME}/.local/share/personal/tools'
    subprocess.run(ssh + [f'mkdir -p {tools} && cat > {tools}/{name}.tar.gz'], input=archive.read_bytes(), capture_output=True, check=True, timeout=300)
    run(ssh + [f'tar -xzf {tools}/{name}.tar.gz -C {tools} && {tools}/{name}/t3 --version'])
    server = f'{tools}/{name}/t3'
    # The plays read the revision's scripts from development_source.
    run(ssh + ['mkdir -p source/ansible && ln -sfn ~/baseline source/ansible/ubuntu'])
    run(ssh + ['! command -v gdm3 && ! test -e /etc/gdm3/custom.conf'])
    play(ssh, 't3-policy.yml', t3_executable=server)
    first = play(ssh, 't3-headless.yml', t3_server_path=server)
    (ROOT / 't3-headless-first.log').write_text(first.stdout + first.stderr)
    wait_for(ssh, answers(SERVER), 60, 'the headless T3 server did not answer its local API')
    run(ssh + ['printf preserved > ~/.t3/fleet-test-preserved'])
    pid = main_pid(ssh, SERVER)
    repeat = play(ssh, 't3-headless.yml', t3_server_path=server)
    (ROOT / 't3-headless-repeat.log').write_text(repeat.stdout + repeat.stderr)
    assert 'changed=0' in repeat.stdout, 'a second t3-headless.yml run changed the worker'
    assert main_pid(ssh, SERVER) == pid, 'the T3 server restarted on a no-change run'
    play(ssh, 'recovery.yml', t3_unit=SERVER)
    user(ssh, 'systemctl --user is-active personal-worker-recovery.timer')
    # A killed process is restarted by its own unit (Restart=always) ...
    user(ssh, f'systemctl --user kill -s SIGKILL {SERVER}')
    wait_for(ssh, answers(SERVER), 60, 'the killed T3 server was not restarted')
    assert main_pid(ssh, SERVER) != pid, 'the killed T3 server process was not replaced'
    # ... and a stopped one by the recovery timer: every minute, the
    # documented bound, plus one run of the health script.
    user(ssh, f'systemctl --user stop {SERVER}')
    took = wait_for(ssh, answers(SERVER), 150, 'the recovery timer did not start the stopped T3 server')
    print(f'headless T3 server: no-op, killed process restarted, stopped server started by the timer in {took:.0f} s', flush=True)
    return {'server': server, 'version': version}


def after_headless_reboot(ssh, t3):
    """After a reboot nobody has logged in to: the server started with the
    user manager, before the SSH session that checks it."""
    wait_for(ssh, answers(SERVER), 120, 'the headless T3 server did not start after a reboot')
    started = int(user(ssh, f'systemctl --user show {SERVER} -p ActiveEnterTimestampMonotonic --value').stdout.strip())
    session = int(run(ssh + ['loginctl show-session "$XDG_SESSION_ID" -p TimestampMonotonic --value']).stdout.strip())
    assert 0 < started < session, 'the T3 server was not started before anyone logged in'
    run(ssh + ['test "$(loginctl show-user fleettest -p Linger --value)" = yes && test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    for _ in range(30):
        policy = run(ssh + [f'{t3["server"]} policy show']).stdout
        if 'loaded this policy.' in policy:
            break
        time.sleep(1)
    (ROOT / 't3-policy-check.log').write_text(policy)
    assert 'loaded this policy.' in policy, 'running T3 did not load managed update policy'
    print('headless T3 server started at boot with nobody logged in and loaded the managed policy', flush=True)


def test_desktop(ssh, t3):
    """Opt-in: the same worker switched to the desktop session keeps ~/.t3,
    runs the desktop app in the auto-login session after a reboot, and the
    recovery timer starts a stopped app."""
    version, _, desktop_sha = pins()
    name = f'T3-Code-{version}-amd64.deb'
    package = ROOT / name
    download(f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}', package, desktop_sha)
    run(ssh + ['sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes ubuntu-desktop-minimal'])
    applied = play(ssh, 't3-desktop.yml', t3_desktop_url=f'https://github.com/pingdotgg/t3code/releases/download/v{version}/{name}', t3_desktop_name=name, t3_desktop_sha256=desktop_sha)
    (ROOT / 't3-desktop-first.log').write_text(applied.stdout + applied.stderr)
    run(ssh + [f'! test -e ~/.config/systemd/user/{SERVER} && test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    play(ssh, 'recovery.yml')
    reboot(ssh)
    wait_for(ssh, answers(APP), 300, 'the desktop app did not start in the auto-login session after a reboot')
    user(ssh, f'systemctl --user stop {APP}')
    took = wait_for(ssh, answers(APP), 150, 'the recovery timer did not start the stopped desktop app')
    run(ssh + ['test "$(cat ~/.t3/fleet-test-preserved)" = preserved'])
    print(f'desktop T3 app: switched from headless keeping ~/.t3, auto-login after reboot, stopped app started by the timer in {took:.0f} s', flush=True)


def test_drift(ssh, command):
    # Disposable guest fault injection only. Repair uses the unchanged tracked
    # baseline, never a production one-off edit.
    run(ssh + ["sudo systemctl unmask sleep.target && printf '# Managed by personal Fleet; injected fixture drift\\nAllowTcpForwarding no\\n' | sudo tee /etc/ssh/sshd_config.d/60-personal-fleet.conf >/dev/null"])
    repaired = run(ssh + [command])
    (ROOT / 'drift-repair.log').write_text(repaired.stdout)
    run(ssh + ['test "$(systemctl is-enabled sleep.target)" = masked && sudo sshd -T | grep -qx "allowtcpforwarding yes"'])
    repeated = run(ssh + [command])
    (ROOT / 'drift-repeat.log').write_text(repeated.stdout + repeated.stderr)
    assert 'changed=0' in repeated.stdout, 'repaired baseline did not converge'
    # Simulate a resource-policy rejection without filling a disk or killing work.
    low_disk = subprocess.run(ssh + [command + ' --extra-vars \'{"worker_minimum_free_disk_mib":1000000000}\''], capture_output=True, text=True, timeout=120)
    (ROOT / 'capacity-refusal.log').write_text(low_disk.stdout + low_disk.stderr)
    assert low_disk.returncode != 0 and 'RESOURCE_CAPACITY_REQUIRED' in low_disk.stdout
    print('source-owned sleep/SSH drift repaired; injected capacity refusal preserved work', flush=True)


def test_agent(ssh):
    # No tailnet/production contact: this explicit fault fixture maps the private
    # hub name to guest loopback with no TLS listener. Service health is NOT
    # authenticated connection or fresh-metrics acceptance.
    run(ssh + ["grep -q 'fixture.fixture.ts.net' /etc/hosts || printf '127.0.0.1 fixture.fixture.ts.net\\n' | sudo tee -a /etc/hosts >/dev/null"])
    variables = json.dumps({'beszel_node': 'fixture-node', 'beszel_hub_url': 'https://fixture.fixture.ts.net:8443', 'beszel_public_key': (ROOT / 'host.pub').read_text().strip(), 'beszel_agent_token': 'disposable-fixture-not-a-live-credential'})
    command = 'cd beszel/monitoring && ~/verify agent'
    first = run(ssh + [command], input=variables)
    (ROOT / 'agent-first.log').write_text(first.stdout + first.stderr)
    pid = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
    second = run(ssh + [command], input=variables)
    (ROOT / 'agent-repeat.log').write_text(second.stdout + second.stderr)
    assert 'changed=0' in second.stdout
    assert run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip() == pid, 'healthy agent restarted'
    # Repair owned, nonsecret configuration without replacing agent identity.
    run(ssh + ["printf 'HUB_URL=https://drift.fixture.ts.net:8443\\nSYSTEM_NAME=drift-node\\n' | sudo tee /etc/personal-beszel/agent.env >/dev/null"])
    repaired = run(ssh + [command], input=variables)
    (ROOT / 'agent-drift-repair.log').write_text(repaired.stdout + repaired.stderr)
    restored = run(ssh + ['sudo cat /etc/personal-beszel/agent.env']).stdout
    assert restored == 'HUB_URL=https://fixture.fixture.ts.net:8443\nSYSTEM_NAME=fixture-node\n', 'owned agent configuration drift was not repaired'
    repeated = run(ssh + [command], input=variables)
    assert 'changed=0' in repeated.stdout, 'agent drift repair did not converge'
    pid = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
    run(ssh + ["printf preserved | sudo tee /var/lib/beszel-agent/fixture-preserved >/dev/null && sudo systemctl kill --signal=SIGKILL beszel-agent.service"])
    for _ in range(30):
        current = run(ssh + ['systemctl show beszel-agent.service --property=MainPID --value']).stdout.strip()
        if current != '0' and current != pid:
            break
        time.sleep(1)
    assert current != '0' and current != pid, 'agent did not recover within restart bound'
    print('native agent no-op and bounded crash recovery passed; hub intentionally unreachable', flush=True)


if __name__ == '__main__':
    main()
