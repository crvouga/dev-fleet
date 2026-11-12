"""Every Ubuntu package ansible/ubuntu/policy.json pins exists, at exactly its
pinned version, in the snapshot the policy names: for every accepted release
and architecture. A pin moved without its snapshot (or a snapshot moved past
a pin) fails here instead of on a machine, where the baseline finds no
installation candidate.

    python3 ansible/ubuntu/tests/snapshot-pins.py

Reads the Packages indexes of snapshot.ubuntu.com; changes nothing.
"""
import gzip
import json
from pathlib import Path
import sys
import urllib.request

POLICY = Path(__file__).resolve().parents[1] / 'policy.json'
COMPONENTS = ('main', 'universe', 'restricted', 'multiverse')


def versions(snapshot, codename, architecture):
    """Every version of every package the snapshot offers this release."""
    found = {}
    for suite in (codename, f'{codename}-updates', f'{codename}-security'):
        for component in COMPONENTS:
            url = f'https://snapshot.ubuntu.com/ubuntu/{snapshot}/dists/{suite}/{component}/binary-{architecture}/Packages.gz'
            with urllib.request.urlopen(url, timeout=120) as response:
                index = gzip.decompress(response.read()).decode()
            name = None
            for line in index.splitlines():
                if line.startswith('Package: '):
                    name = line[len('Package: '):]
                elif line.startswith('Version: ') and name:
                    found.setdefault(name, set()).add(line[len('Version: '):])
    return found


def main():
    policy = json.loads(POLICY.read_text())
    missing = []
    for release in policy['releases']:
        # The same merge src/platform/ubuntu-release.ts makes.
        pins = {
            **policy['packages'], **release.get('packages', {}),
            **policy['browser']['packages'], **release.get('browserPackages', {}),
        }
        for architecture in release['architectures']:
            offered = versions(policy['snapshot'], release['codename'], architecture)
            absent = [(name, version) for name, version in pins.items() if version not in offered.get(name, ())]
            for name, version in absent:
                missing.append(f"Ubuntu {release['release']} {architecture}: {name}={version} is not in snapshot {policy['snapshot']}, which offers {', '.join(sorted(offered.get(name, []))) or 'no version'}")
            print(f"Ubuntu {release['release']} {architecture}: {len(pins) - len(absent)} of {len(pins)} pins are in snapshot {policy['snapshot']}", flush=True)
    for line in missing:
        print(f'::error::{line}')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
