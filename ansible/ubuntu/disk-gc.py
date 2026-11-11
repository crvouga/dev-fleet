#!/usr/bin/python3
"""Recover disk space by deleting only what a build or install can recreate.

Managed by personal fleet-sync (tasks/resources.yml) as
personal-fleet-disk-gc.service, started hourly by personal-fleet-disk-gc.timer.

What it deletes:
  * dependency and build directories (node_modules, .turbo, dist, Rust target,
    ...) inside git checkouts under the home directory, only when git says the
    directory is ignored, the checkout has been idle for --idle-days and no
    process is running inside it;
  * Docker images and build cache that no container uses and that are older
    than --docker-age-hours (never containers or volumes);
  * the apt package cache.
When a watched filesystem has less than --pressure-mib free, idle checkouts
qualify after --pressure-idle-hours, Docker leftovers after
--pressure-docker-age-hours, and aged entries of each --pressure-cache
directory are removed too.

It never deletes a checkout, a tracked file, uncommitted work, a container or
a volume. Every decision is one JSON line on stdout.

Usage: disk-gc.py --home H [--path P ...] [--idle-days N] [--pressure-mib N]
                  [--pressure-idle-hours N] [--docker-age-hours N]
                  [--pressure-docker-age-hours N] [--pressure-cache DIR ...]
                  [--max-depth N] [--proc DIR] [--dry-run]
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

MIB = 1024 * 1024
HOUR = 3600
# Directory names that hold only installed dependencies or build output.
REGENERABLE = frozenset({
    'node_modules', '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.astro',
    '.vite', '.parcel-cache', '.expo', '.gradle', 'dist', 'build', 'coverage',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__', '.venv',
})
# Directory names that are regenerable only beside the manifest that builds them.
REGENERABLE_BESIDE = {'target': 'Cargo.toml'}
# Hidden directories under the home directory that still hold checkouts.
HIDDEN_ROOTS = frozenset({'.t3'})
GIT = ['git', '-c', 'safe.directory=*']


def log(**event):
    print(json.dumps(event, sort_keys=True), flush=True)


def free_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def mtime(path):
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return 0.0


def is_real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def find_checkouts(home, max_depth):
    """Git checkouts (repositories and worktrees) under home, outermost only."""
    found = []

    def walk(directory, depth):
        if os.path.lexists(os.path.join(directory, '.git')):
            found.append(directory)
            return
        if depth >= max_depth:
            return
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            name = entry.name
            if name in REGENERABLE or name in REGENERABLE_BESIDE:
                continue
            if name.startswith('.') and not (depth == 0 and name in HIDDEN_ROOTS):
                continue
            walk(entry.path, depth + 1)

    walk(home, 0)
    return sorted(found)


def git_dir(checkout):
    """The checkout's git directory, following a worktree's .git file."""
    dot_git = os.path.join(checkout, '.git')
    if is_real_dir(dot_git):
        return dot_git
    try:
        text = Path(dot_git).read_text()
    except OSError:
        return None
    if not text.startswith('gitdir:'):
        return None
    target = text[len('gitdir:'):].strip()
    target = os.path.normpath(os.path.join(checkout, target))
    return target if is_real_dir(target) else None


def run_git(checkout, args, data=None):
    try:
        out = subprocess.run(GIT + ['-C', checkout] + args, input=data,
                             capture_output=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out


def candidates(checkout):
    """Regenerable directories in a checkout, outermost only, never through a link."""
    found = []
    for current, dirs, files in os.walk(checkout):
        keep = []
        for name in dirs:
            path = os.path.join(current, name)
            if name == '.git' or os.path.islink(path):
                continue
            if os.path.lexists(os.path.join(path, '.git')):
                continue  # a nested repository answers for itself
            beside = REGENERABLE_BESIDE.get(name)
            if name in REGENERABLE or (beside and beside in files):
                found.append(path)
                continue
            keep.append(name)
        dirs[:] = keep
    return found


def ignored(checkout, paths):
    """The subset of paths git ignores; tracked or unignored paths are kept."""
    if not paths:
        return []
    rel = [os.path.relpath(p, checkout) for p in paths]
    out = run_git(checkout, ['check-ignore', '--stdin', '-z'],
                  data=('\0'.join(rel) + '\0').encode())
    if out is None or out.returncode not in (0, 1):
        return []
    hits = {item for item in out.stdout.decode(errors='replace').split('\0') if item}
    return [p for p, r in zip(paths, rel) if r in hits or r.rstrip('/') in hits]


def git_activity(checkout, gdir):
    """The latest commit, checkout or index refresh: cheap, read first."""
    marks = [checkout, os.path.join(gdir, 'index'), os.path.join(gdir, 'HEAD'),
             os.path.join(gdir, 'logs', 'HEAD')]
    return max(mtime(p) for p in marks)


def last_activity(checkout, gdir, dirs):
    """The latest sign of work: git activity, changed files, build output writes."""
    latest = max([git_activity(checkout, gdir)] + [mtime(p) for p in dirs])
    out = run_git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if out is None or out.returncode != 0:
        return None
    entries = out.stdout.decode(errors='replace').split('\0')
    for entry in entries:
        if len(entry) > 3:
            latest = max(latest, mtime(os.path.join(checkout, entry[3:])))
    return latest


def busy_roots(proc):
    """Working directories of every running process."""
    roots = set()
    try:
        pids = [p for p in os.listdir(proc) if p.isdigit()]
    except OSError:
        return roots
    for pid in pids:
        try:
            roots.add(os.readlink(os.path.join(proc, pid, 'cwd')))
        except OSError:
            continue
    return roots


def in_use(checkout, roots):
    prefix = checkout.rstrip('/') + '/'
    return any(r == checkout or r.startswith(prefix) for r in roots)


def size_of(path):
    total = 0
    for current, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                total += os.lstat(os.path.join(current, name)).st_blocks * 512
            except OSError:
                continue
    return total


def remove(path, dry_run):
    """Deletes one directory without following links; returns bytes freed."""
    if not is_real_dir(path):
        return 0
    size = size_of(path)
    if not dry_run:
        shutil.rmtree(path, ignore_errors=True)
        if os.path.lexists(path):
            return 0
    return size


def collect_checkouts(home, idle_seconds, max_depth, proc, now, dry_run):
    roots = busy_roots(proc)
    freed = 0
    for checkout in find_checkouts(home, max_depth):
        gdir = git_dir(checkout)
        if gdir is None:
            log(event='checkout_skipped', checkout=checkout, reason='no_git_dir')
            continue
        if in_use(checkout, roots) or now - git_activity(checkout, gdir) < idle_seconds:
            continue
        dirs = ignored(checkout, candidates(checkout))
        if not dirs:
            continue
        latest = last_activity(checkout, gdir, dirs)
        if latest is None:
            log(event='checkout_skipped', checkout=checkout, reason='git_status_failed')
            continue
        if now - latest < idle_seconds:
            continue
        for path in dirs:
            got = remove(path, dry_run)
            freed += got
            log(event='removed', path=path, mib=got // MIB, dry_run=dry_run)
    return freed


def collect_cache(directory, age_seconds, now, dry_run):
    """Removes top-level cache entries not written for age_seconds."""
    freed = 0
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return 0
    for entry in entries:
        if now - mtime(entry.path) < age_seconds:
            continue
        if entry.is_dir(follow_symlinks=False):
            got = remove(entry.path, dry_run)
        elif entry.is_file(follow_symlinks=False):
            got = entry.stat(follow_symlinks=False).st_blocks * 512
            if not dry_run:
                try:
                    os.unlink(entry.path)
                except OSError:
                    got = 0
        else:
            continue
        freed += got
    if freed:
        log(event='cache_pruned', cache=directory, mib=freed // MIB, dry_run=dry_run)
    return freed


def command(argv, dry_run, name):
    if shutil.which(argv[0]) is None:
        return
    if dry_run:
        log(event='would_run', step=name)
        return
    try:
        out = subprocess.run(argv, capture_output=True, timeout=1800)
        log(event='ran', step=name, ok=out.returncode == 0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(event='ran', step=name, ok=False, error=type(exc).__name__)


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    parser.add_argument('--path', action='append', default=[])
    parser.add_argument('--idle-days', type=float, default=7)
    parser.add_argument('--pressure-mib', type=int, default=15360)
    parser.add_argument('--pressure-idle-hours', type=float, default=12)
    parser.add_argument('--docker-age-hours', type=int, default=168)
    parser.add_argument('--pressure-docker-age-hours', type=int, default=24)
    parser.add_argument('--pressure-cache', action='append', default=[])
    parser.add_argument('--max-depth', type=int, default=4)
    parser.add_argument('--proc', default='/proc')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    home = os.path.realpath(args.home)
    paths = args.path or ['/', home]
    now = time.time()
    before = {p: free_bytes(p) for p in paths}
    pressure = min(before.values()) < args.pressure_mib * MIB
    idle = args.pressure_idle_hours * HOUR if pressure else args.idle_days * 24 * HOUR
    docker_age = args.pressure_docker_age_hours if pressure else args.docker_age_hours
    log(event='started', pressure=pressure, idle_hours=idle / HOUR,
        docker_age_hours=docker_age, dry_run=args.dry_run,
        free_mib={p: v // MIB for p, v in before.items()})

    freed = collect_checkouts(home, idle, args.max_depth, args.proc, now, args.dry_run)
    if pressure:
        for cache in args.pressure_cache:
            freed += collect_cache(os.path.join(home, cache), idle, now, args.dry_run)
    command(['docker', 'image', 'prune', '--all', '--force', '--filter',
             f'until={docker_age}h'], args.dry_run, 'docker_images')
    command(['docker', 'builder', 'prune', '--all', '--force', '--filter',
             f'until={docker_age}h'], args.dry_run, 'docker_build_cache')
    command(['apt-get', 'clean'], args.dry_run, 'apt_cache')

    after = {p: free_bytes(p) for p in paths}
    log(event='finished', checkout_mib=freed // MIB, dry_run=args.dry_run,
        free_mib={p: v // MIB for p, v in after.items()})


if __name__ == '__main__':
    main(sys.argv[1:])
