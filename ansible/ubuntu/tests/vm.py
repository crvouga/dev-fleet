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
import urllib.request

ROOT = Path('/artifacts')
BOOTSTRAP = Path('/bootstrap/revision').exists()
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
        with urllib.request.urlopen('https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img', timeout=60) as response, image.open('wb') as target:
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
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(ROOT / 'guest.qcow2'), '64G' if BOOTSTRAP else '12G'])
    ssh = ['ssh', '-i', str(ROOT / 'client'), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={ROOT}/known_hosts', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', '2222', 'fleettest@127.0.0.1']
    log = (ROOT / 'serial.log').open('w')
    vm = subprocess.Popen(['qemu-system-x86_64', '-enable-kvm', '-cpu', 'host', '-smp', '2', '-m', '3072', '-display', 'none', '-serial', 'stdio', '-drive', f'file={ROOT}/guest.qcow2,if=virtio', '-drive', f'file={ROOT}/seed.img,format=raw,if=virtio', '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22', '-device', 'virtio-net-pci,netdev=net0'], stdout=log, stderr=log)
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
        t3_tested = test_t3(ssh)
        test_agent(ssh)
        boot = run(ssh + ['cat /proc/sys/kernel/random/boot_id']).stdout
        subprocess.run(ssh + ['sudo reboot'], capture_output=True, timeout=10)
        time.sleep(3)
        for _ in range(120):
            result = subprocess.run(ssh + ['cat /proc/sys/kernel/random/boot_id'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and result.stdout != boot:
                break
            time.sleep(2)
        assert result.returncode == 0 and result.stdout != boot, 'reboot reconnect failed'
        run(ssh + ['test "$(systemctl is-enabled sleep.target)" = masked && test "$(cat work/uncommitted)" = preserved'])
        if t3_tested:
            run(ssh + ['systemctl --user is-active t3code.service && test \"$(cat ~/.t3/fleet-test-preserved)\" = preserved'])
            for _ in range(30):
                policy = run(ssh + ['tools/t3-0.1.7-linux-x64/t3 policy show']).stdout
                if 'loaded this policy.' in policy:
                    break
                time.sleep(1)
            (ROOT / 't3-policy-check.log').write_text(policy)
            assert 'loaded this policy.' in policy, 'running T3 did not load managed update policy'
        verification = Path('/verification/verify')
        if verification.exists():
            subprocess.run(ssh + ['cat > verify && chmod 700 verify'], input=verification.read_bytes(), capture_output=True, check=True, timeout=60)
            evidence = run(ssh + ['./verify'])
            (ROOT / 'boot-policy-evidence.json').write_text(evidence.stdout)
            print('production boot-policy observer passed after VM reboot', flush=True)
        run(ssh + ['systemctl is-active beszel-agent.service && test \"$(sudo cat /var/lib/beszel-agent/fixture-preserved)\" = preserved'])
        print(json.dumps({'passed': ['Ubuntu baseline apply', 'repeat no-op', 'sudoers validation', 'sleep target masked', 'reboot and fresh SSH', 'uncommitted file preserved', 'sleep/SSH drift repair and injected capacity gate', 'native Beszel agent no-op/crash/reboot with intentionally unreachable fixture hub'] + (['native T3 service install, no-op, crash recovery, managed update policy and reboot'] if t3_tested else []), 'unverified': ['Tailscale', 'paired T3', 'Beszel agent/private metrics', 'full remote bootstrap']}), flush=True)
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


def test_t3(ssh):
    artifact = Path('/t3/t3.tar.gz')
    if not artifact.exists():
        return False
    assert hashlib.file_digest(artifact.open('rb'), 'sha256').hexdigest() == 'c089892bf7922e2e73c6f44a5d1ea125c99f70e378c18361cbbed2fba1920e6c'
    subprocess.run(ssh + ['mkdir -p tools && cat > tools/t3.tar.gz'], input=artifact.read_bytes(), capture_output=True, check=True, timeout=120)
    run(ssh + ['tar -xzf tools/t3.tar.gz -C tools'])
    run(ssh + ["cd baseline && ansible-playbook t3-policy.yml --extra-vars '{\"t3_executable\":\"/home/fleettest/tools/t3-0.1.7-linux-x64/t3\"}'"])
    run(ssh + ['tools/t3-0.1.7-linux-x64/t3 service install'])
    run(ssh + ['systemctl --user is-active t3code.service && printf preserved > ~/.t3/fleet-test-preserved'])
    pid = run(ssh + ['systemctl --user show t3code.service -p MainPID --value']).stdout
    run(ssh + ['tools/t3-0.1.7-linux-x64/t3 service install'])
    assert run(ssh + ['systemctl --user show t3code.service -p MainPID --value']).stdout == pid, 'native service needlessly restarted'
    run(ssh + ['systemctl --user kill -s SIGKILL t3code.service'])
    time.sleep(8)
    run(ssh + ['systemctl --user is-active t3code.service'])
    assert run(ssh + ['systemctl --user show t3code.service -p MainPID --value']).stdout != pid, 'native crash recovery did not replace process'
    print('native T3 no-op and injected crash recovery passed', flush=True)
    return True





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
    low_disk = subprocess.run(ssh + [command + ' --extra-vars \'{"minimumFreeDiskMiB":1000000000}\''], capture_output=True, text=True, timeout=120)
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
