#!/usr/bin/python3
"""Stop the user process group that is filling the disk before it runs out.

Managed by personal fleet-sync (tasks/resources.yml) as
personal-fleet-disk-guard.service. Every interval it measures free space on the
watched filesystems and the bytes each leaf cgroup under user.slice wrote. When
any watched filesystem is below the floor, it kills only the single cgroup that
wrote the most during the last interval, and only if that is at least the write
threshold. It never deletes files, never touches system services and never
kills idle work. Free space must be recovered by a person.

Usage: disk-guard.py --path / --path /home/me [--floor-mib N] [--write-mib N]
                     [--interval S] [--cgroup-root DIR] [--dry-run]
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

MIB = 1024 * 1024


def leaf_writes(root):
    """Bytes written so far by every leaf cgroup below root, from io.stat."""
    writes = {}
    for current, dirs, files in os.walk(root):
        if dirs or 'io.stat' not in files:
            continue
        try:
            text = Path(current, 'io.stat').read_text()
        except OSError:
            continue
        total = 0
        for line in text.splitlines():
            for field in line.split()[1:]:
                key, _, value = field.partition('=')
                if key == 'wbytes' and value.isdigit():
                    total += int(value)
        writes[current] = total
    return writes


def choose_victim(previous, current, low, threshold):
    """The leaf that wrote the most since the previous sample, if it is a runaway."""
    if not low:
        return None
    best, best_delta = None, 0
    for path, total in current.items():
        delta = total - previous.get(path, total)
        if delta > best_delta:
            best, best_delta = path, delta
    if best is None or best_delta < threshold:
        return None
    return best, best_delta


def free_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def log(**event):
    print(json.dumps(event, sort_keys=True), flush=True)


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--path', action='append', required=True)
    parser.add_argument('--floor-mib', type=int, default=3072)
    parser.add_argument('--write-mib', type=int, default=32)
    parser.add_argument('--interval', type=float, default=5.0)
    parser.add_argument('--cgroup-root', default='/sys/fs/cgroup/user.slice')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    floor, threshold = args.floor_mib * MIB, args.write_mib * MIB
    log(event='started', paths=args.path, floor_mib=args.floor_mib,
        write_mib=args.write_mib, interval=args.interval, dry_run=args.dry_run)
    previous = leaf_writes(args.cgroup_root)
    while True:
        time.sleep(args.interval)
        try:
            current = leaf_writes(args.cgroup_root)
            free = {path: free_bytes(path) for path in args.path}
            low = [path for path, value in free.items() if value < floor]
            victim = choose_victim(previous, current, bool(low), threshold)
            previous = current
            if victim is None:
                continue
            path, delta = victim
            event = dict(event='runaway_writer', cgroup=path,
                         wrote_mib=delta // MIB, low=low,
                         free_mib={p: v // MIB for p, v in free.items()})
            if not args.dry_run:
                Path(path, 'cgroup.kill').write_text('1\n')
                event['killed'] = True
            log(**event)
        except OSError as exc:
            log(event='check_failed', error=type(exc).__name__)


if __name__ == '__main__':
    main(sys.argv[1:])
