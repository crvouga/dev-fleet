"""Opt-in disposable upstream acceptance; no production credentials or services.
Run: python3 ansible/monitoring/tests/upstream.py
Requires Linux amd64, HTTPS downloads, and loopback networking. Not a VM/reboot test.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request

VERSION = '0.21.1'
ARTIFACTS = {
    'beszel': '70857d0489cf790224167815c82f8807cc28134d27f209b58b1cd36e4082931a',
    'beszel-agent': '3b6ee592632ec03b9a43312e99a40203a7b3d83fe40dd0c25acda1eb915ea7c0',
}


def download(root, name, digest):
    archive = root / (name + '.tgz')
    url = f'https://github.com/henrygd/beszel/releases/download/v{VERSION}/{name}_linux_amd64.tar.gz'
    with urllib.request.urlopen(url, timeout=60) as response:
        archive.write_bytes(response.read(64 * 1024 * 1024))
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest, 'checksum mismatch'
    with tarfile.open(archive) as package:
        package.extractall(root / name, filter='data')
    return root / name / name


def main():
    assert os.uname().machine == 'x86_64', 'This acceptance fixture is Linux amd64 only'
    with tempfile.TemporaryDirectory(prefix='personal-beszel-test-') as temporary:
        root = Path(temporary)
        binaries = {name: download(root, name, digest) for name, digest in ARTIFACTS.items()}
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1', 0))
            port = port_socket.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        processes = []
        token = ''

        def request(path, data=None):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = token
            req = urllib.request.Request(url + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=5) as response:
                body = response.read(8 * 1024 * 1024)
                return json.loads(body) if body else None

        def start_agent():
            env = {**os.environ, 'HUB_URL': url, 'TOKEN_FILE': str(root / 'token'),
                   'KEY_FILE': str(root / 'key'), 'DATA_DIR': str(root / 'agent-data'),
                   'SYSTEM_NAME': 'acceptance-node', 'DISABLE_SSH': 'true',
                   'SKIP_SYSTEMD_LOGS': 'true'}
            process = subprocess.Popen([str(binaries['beszel-agent'])], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(process)
            return process

        try:
            processes.append(subprocess.Popen([str(binaries['beszel']), 'serve', '--http', f'127.0.0.1:{port}', '--dir', str(root / 'hub-data')],
                env={**os.environ, 'DISABLE_SSH': 'true', 'CHECK_UPDATES': 'false'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for _ in range(50):
                try:
                    request('/api/health')
                    break
                except (OSError, ValueError):
                    time.sleep(0.2)
            password = secrets.token_urlsafe(32)
            request('/api/beszel/create-user', {'email': 'fixture@example.invalid', 'password': password})
            login = request('/api/collections/users/auth-with-password', {'identity': 'fixture@example.invalid', 'password': password})
            token = login['token']
            info = request('/api/beszel/info')
            assert info['v'] == VERSION
            system = request('/api/collections/systems/records', {'name': 'acceptance-node', 'host': '127.0.0.1', 'port': '45876', 'users': [login['record']['id']]})
            agent_token = secrets.token_urlsafe(32)
            request('/api/collections/fingerprints/records', {'system': system['id'], 'token': agent_token})
            (root / 'token').write_text(agent_token)
            (root / 'key').write_text(info['key'])
            agent = start_agent()
            for _ in range(90):
                rows = request('/api/collections/system_stats/records?perPage=1&sort=-created')['items']
                if rows:
                    break
                time.sleep(1)
            assert rows and rows[0]['system'] == system['id'], 'fresh metrics not received'
            fingerprint = request('/api/collections/fingerprints/records')['items'][0]['fingerprint']
            assert fingerprint, 'fingerprint not enrolled'
            agent.terminate()
            agent.wait(timeout=10)
            start_agent()
            time.sleep(3)
            assert len(request('/api/collections/systems/records')['items']) == 1, 'duplicate registration'
            assert request('/api/collections/fingerprints/records')['items'][0]['fingerprint'] == fingerprint
            # PocketBase's supported backup API requires its separate superuser
            # collection. This credential exists only in the disposable fixture.
            token = request('/api/collections/_superusers/auth-with-password', {'identity': 'fixture@example.invalid', 'password': password})['token']
            backup = 'fleet-acceptance.zip'
            request('/api/backups', {'name': backup})
            for _ in range(30):
                if any(item['key'] == backup for item in request('/api/backups')):
                    break
                time.sleep(1)
            else:
                raise AssertionError('backup unavailable')
            agent = processes[-1]
            agent.terminate()
            agent.wait(timeout=10)
            # A disposable second record proves restore actually reverts state.
            request('/api/collections/systems/records', {'name': 'after-backup', 'host': '127.0.0.2', 'port': '45876', 'users': [login['record']['id']]})
            try:
                request('/api/backups/' + backup + '/restore', {})
            except (OSError, ValueError):
                pass  # Upstream restarts the hub after a successful restore.
            for _ in range(50):
                try:
                    restored = request('/api/collections/systems/records')['items']
                    if len(restored) == 1 and restored[0]['id'] == system['id']:
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.2)
            else:
                raise AssertionError('backup restore did not preserve canonical registration')
            assert request('/api/collections/fingerprints/records')['items'][0]['fingerprint'] == fingerprint
            print(json.dumps({'version': 1, 'upstream': VERSION, 'passed': ['authenticated-api', 'per-node-token', 'fresh-metrics', 'restart-identity-preservation', 'no-duplicate-registration', 'supported-api-backup-restore'], 'unverified': ['systemd', 'reboot', 'Tailscale', 'remote-client']}))
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == '__main__':
    main()
