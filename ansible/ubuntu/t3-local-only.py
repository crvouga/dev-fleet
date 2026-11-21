"""Keep a worker's T3 desktop app serving on loopback only.

The desktop app binds its server to every address when its desktop setting
`serverExposureMode` is "network-accessible", and the T3 service environment
does when it says T3CODE_LAN=true. A worker needs neither: its route is
`tailscale serve` to 127.0.0.1. The setting is not one an administrator policy
can lock, and the running app writes its settings from memory, so this runs
before the app starts (ExecStartPre of t3code-desktop.service) and puts both
back to local-only. Every other setting is kept as it is.

Prints one JSON line naming what it changed. A file it cannot read or parse is
left alone and reported: the app's own settings are never replaced on a guess.

Usage: t3-local-only.py --home ~/.t3
"""
import argparse
import json
import os
import sys
import tempfile

LOCAL_ONLY = 'local-only'


def replace(path, text):
    """Write text to path atomically, keeping the file's mode."""
    mode = os.stat(path).st_mode & 0o7777
    directory = os.path.dirname(path)
    descriptor, staged = tempfile.mkstemp(dir=directory, prefix='.personal-fleet-')
    try:
        with os.fdopen(descriptor, 'w') as file:
            file.write(text)
        os.chmod(staged, mode)
        os.replace(staged, path)
    except BaseException:
        os.unlink(staged)
        raise


def desktop_settings(path):
    """'changed', 'kept', 'absent' or 'unreadable'."""
    try:
        with open(path) as file:
            settings = json.load(file)
    except FileNotFoundError:
        return 'absent'
    except (OSError, ValueError):
        return 'unreadable'
    if not isinstance(settings, dict):
        return 'unreadable'
    if settings.get('serverExposureMode', LOCAL_ONLY) == LOCAL_ONLY:
        return 'kept'
    settings['serverExposureMode'] = LOCAL_ONLY
    replace(path, json.dumps(settings, indent=2) + '\n')
    return 'changed'


def service_environment(path):
    """'changed', 'kept', 'absent' or 'unreadable'."""
    try:
        with open(path) as file:
            lines = file.read().splitlines()
    except FileNotFoundError:
        return 'absent'
    except (OSError, UnicodeDecodeError):
        return 'unreadable'
    kept = [line for line in lines if not line.startswith('T3CODE_LAN=')]
    if len(kept) == len(lines) - 1 and 'T3CODE_LAN=false' in lines:
        return 'kept'
    replace(path, '\n'.join(kept + ['T3CODE_LAN=false']) + '\n')
    return 'changed'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True, help='The T3 home, T3CODE_HOME')
    args = parser.parse_args()
    report = {
        'desktopSettings': desktop_settings(os.path.join(args.home, 'userdata', 'desktop-settings.json')),
        'serviceEnvironment': service_environment(os.path.join(args.home, 'service.env')),
    }
    print(json.dumps(report), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
