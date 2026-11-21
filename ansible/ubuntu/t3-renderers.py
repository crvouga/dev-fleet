#!/usr/bin/python3
"""Place only Electron renderers in the desktop service's delegated subgroup."""
import argparse
import os
import re
from pathlib import Path
import sys


def arguments(process):
    """The arguments of a process. Chromium rewrites its process title, so a
    renderer's arguments are joined by spaces rather than NULs."""
    return re.split(rb'[\0 ]', (process / 'cmdline').read_bytes())


def assign(root, group, proc, high, maximum):
    # DelegateSubgroup=app keeps the unit root free of processes so its memory
    # controller can be enabled. Older running units adopt this at next start.
    unit = root / group.lstrip('/')
    app = unit / 'app'
    if not app.is_dir():
        return
    if 'memory' not in (unit / 'cgroup.subtree_control').read_text().split():
        (unit / 'cgroup.subtree_control').write_text('+memory')
    renderers = unit / 'renderers'
    renderers.mkdir(exist_ok=True)
    for name, limit in [('memory.high', high), ('memory.max', maximum)]:
        path = renderers / name
        if not path.exists() or path.read_text().strip() != str(limit):
            with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK, 0o644), 'w') as control:
                control.write(str(limit))
    member = '/' + group.strip('/') + '/app'
    for pid in (app / 'cgroup.procs').read_text().split():
        try:
            process = proc / pid
            if b'--type=renderer' not in arguments(process):
                continue
            # Confirm membership again after reading the process arguments.
            if (process / 'cgroup').read_text().strip().split('::')[-1] != member:
                continue
            with open(renderers / 'cgroup.procs', 'a') as procs:
                procs.write(pid + '\n')
        except (FileNotFoundError, ProcessLookupError):
            continue


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('group')
    parser.add_argument('high', type=int)
    parser.add_argument('maximum', type=int)
    parser.add_argument('--cgroup-root', type=Path, default=Path('/sys/fs/cgroup'))
    parser.add_argument('--proc', type=Path, default=Path('/proc'))
    args = parser.parse_args()
    group = Path(args.group)
    if not group.is_absolute() or '..' in group.parts or group.name != 't3code-desktop.service':
        return 1
    assign(args.cgroup_root, str(group), args.proc,
           args.high * 1024**2, args.maximum * 1024**2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
