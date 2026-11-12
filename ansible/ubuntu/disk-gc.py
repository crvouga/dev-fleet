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
  * the apt package cache;
  * agent worktrees under each --worktree-root that nobody has used for
    --worktree-idle-days, only when Git says they hold no uncommitted,
    untracked or unpushed work and no process runs in them (the branch is
    kept);
  * the oldest files of each --cache-cap DIR=MIB cache beyond its size;
  * all but the newest N files of each --keep-newest DIR=N directory (the
    downloaded T3 packages: the current one and the previous one);
  * tool versions no mise configuration uses (--mise, run as --user).
When a watched filesystem has less than --pressure-mib free, or less than
--pressure-inode-percent of its inodes free, idle checkouts
qualify after --pressure-idle-hours, Docker leftovers after
--pressure-docker-age-hours, and aged entries of each --pressure-cache
directory are removed too.

It never deletes a main checkout, a tracked file, uncommitted or unpushed
work, a container or a volume. Every decision is one JSON line on stdout, and
the last one says how many MiB were reclaimed.

Usage: disk-gc.py --home H [--path P ...] [--idle-days N] [--pressure-mib N]
                  [--pressure-inode-percent N] [--pressure-idle-hours N] [--docker-age-hours N]
                  [--pressure-docker-age-hours N] [--pressure-cache DIR ...]
                  [--worktree-root DIR ...] [--worktree-idle-days N]
                  [--cache-cap DIR=MIB ...] [--keep-newest DIR=N ...]
                  [--mise PATH] [--user NAME]
                  [--max-depth N] [--proc DIR] [--home-only] [--dry-run]

--home-only skips the machine-wide Docker and apt steps.
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


def free_inodes_percent(path):
    """Free inodes as a percentage; None on a filesystem without a fixed count."""
    st = os.statvfs(path)
    if st.f_files <= 0:
        return None
    return st.f_favail * 100 / st.f_files


def under_pressure(paths, pressure_bytes, inode_percent):
    """Any watched filesystem short of free bytes or of free inodes."""
    for path in paths:
        if free_bytes(path) < pressure_bytes:
            return True
        inodes = free_inodes_percent(path)
        if inodes is not None and inodes < inode_percent:
            return True
    return False


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


def linked_worktrees(root, max_depth=3):
    """Linked worktrees (a .git file, never a repository) under root."""
    found = []

    def walk(directory, depth):
        dot_git = os.path.join(directory, '.git')
        if os.path.lexists(dot_git):
            if not is_real_dir(dot_git) and not os.path.islink(dot_git):
                found.append(directory)
            return
        if depth >= max_depth:
            return
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) and entry.name not in REGENERABLE:
                walk(entry.path, depth + 1)

    walk(root, 0)
    return sorted(found)


def unsaved_work(worktree):
    """Why Git cannot vouch for a worktree, or None when everything in it is
    committed and every commit is on a remote."""
    status = run_git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if status is None or status.returncode != 0:
        return 'git_status_failed'
    if status.stdout.strip(b'\0'):
        return 'uncommitted'
    unpushed = run_git(worktree, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes'])
    if unpushed is None or unpushed.returncode != 0:
        return 'git_rev_list_failed'
    if unpushed.stdout.strip():
        return 'unpushed'
    return None


def collect_worktrees(root, idle_seconds, proc, now, dry_run):
    roots = busy_roots(proc)
    freed = 0
    for worktree in linked_worktrees(root):
        gdir = git_dir(worktree)
        if gdir is None or in_use(worktree, roots):
            continue
        if now - git_activity(worktree, gdir) < idle_seconds:
            continue
        latest = last_activity(worktree, gdir, [])
        if latest is None or now - latest < idle_seconds:
            continue
        reason = unsaved_work(worktree)
        if reason:
            log(event='worktree_kept', worktree=worktree, reason=reason)
            continue
        size = size_of(worktree)
        if not dry_run:
            common = run_git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
            if common is None or common.returncode != 0:
                continue
            out = subprocess.run(
                GIT + ['--git-dir', common.stdout.decode().strip(), 'worktree', 'remove', '--force', worktree],
                capture_output=True, timeout=600)
            if out.returncode != 0 or os.path.lexists(worktree):
                log(event='worktree_kept', worktree=worktree, reason='git_worktree_remove_failed')
                continue
        freed += size
        log(event='worktree_removed', worktree=worktree, mib=size // MIB, dry_run=dry_run)
    return freed


def files_under(directory):
    """Every regular file under directory, never through a link."""
    found = []
    for current, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(current, d))]
        for name in files:
            path = os.path.join(current, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                found.append((st.st_mtime, st.st_blocks * 512, path))
    return found


def unlink(path, dry_run):
    if dry_run:
        return True
    try:
        os.unlink(path)
        return True
    except OSError:
        return False


def cap_cache(directory, cap_bytes, dry_run):
    """Removes the oldest files of a cache until it fits its cap."""
    entries = sorted(files_under(directory))
    total = sum(size for _, size, _ in entries)
    freed = 0
    for _, size, path in entries:
        if total - freed <= cap_bytes:
            break
        if unlink(path, dry_run):
            freed += size
    if not dry_run:
        for current, dirs, files in os.walk(directory, topdown=False):
            if current != directory and not dirs and not files:
                try:
                    os.rmdir(current)
                except OSError:
                    pass
    if freed:
        log(event='cache_capped', cache=directory, mib=freed // MIB,
            cap_mib=cap_bytes // MIB, dry_run=dry_run)
    return freed


def keep_newest(directory, count, dry_run):
    """Removes all but the newest count files directly in directory."""
    try:
        entries = [e for e in os.scandir(directory) if e.is_file(follow_symlinks=False)]
    except OSError:
        return 0
    entries.sort(key=lambda e: e.stat(follow_symlinks=False).st_mtime, reverse=True)
    freed = 0
    for entry in entries[count:]:
        size = entry.stat(follow_symlinks=False).st_blocks * 512
        if unlink(entry.path, dry_run):
            freed += size
            log(event='superseded_removed', path=entry.path, mib=size // MIB, dry_run=dry_run)
    return freed


def pair(text, kind):
    name, _, value = text.rpartition('=')
    if not name:
        raise argparse.ArgumentTypeError(f'expected DIR={kind}')
    return name, int(value)


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
    parser.add_argument('--pressure-inode-percent', type=float, default=0)
    parser.add_argument('--pressure-idle-hours', type=float, default=12)
    parser.add_argument('--docker-age-hours', type=int, default=168)
    parser.add_argument('--pressure-docker-age-hours', type=int, default=24)
    parser.add_argument('--pressure-cache', action='append', default=[])
    parser.add_argument('--worktree-root', action='append', default=[])
    parser.add_argument('--worktree-idle-days', type=float, default=30)
    parser.add_argument('--cache-cap', action='append', default=[],
                        type=lambda text: pair(text, 'MIB'))
    parser.add_argument('--keep-newest', action='append', default=[],
                        type=lambda text: pair(text, 'N'))
    parser.add_argument('--mise')
    parser.add_argument('--user')
    parser.add_argument('--max-depth', type=int, default=4)
    parser.add_argument('--proc', default='/proc')
    parser.add_argument('--home-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    home = os.path.realpath(args.home)
    paths = args.path or ['/', home]
    now = time.time()
    before = {p: free_bytes(p) for p in paths}
    pressure = under_pressure(paths, args.pressure_mib * MIB,
                              args.pressure_inode_percent)
    idle = args.pressure_idle_hours * HOUR if pressure else args.idle_days * 24 * HOUR
    docker_age = args.pressure_docker_age_hours if pressure else args.docker_age_hours
    log(event='started', pressure=pressure, idle_hours=idle / HOUR,
        docker_age_hours=docker_age, dry_run=args.dry_run,
        free_mib={p: v // MIB for p, v in before.items()})

    freed = collect_checkouts(home, idle, args.max_depth, args.proc, now, args.dry_run)
    if pressure:
        for cache in args.pressure_cache:
            freed += collect_cache(os.path.join(home, cache), idle, now, args.dry_run)
    reclaimed = freed
    for root in args.worktree_root:
        reclaimed += collect_worktrees(os.path.join(home, root),
                                       args.worktree_idle_days * 24 * HOUR,
                                       args.proc, now, args.dry_run)
    for cache, cap_mib in args.cache_cap:
        reclaimed += cap_cache(os.path.join(home, cache), cap_mib * MIB, args.dry_run)
    for directory, count in args.keep_newest:
        reclaimed += keep_newest(os.path.join(home, directory), count, args.dry_run)
    if args.mise:
        installs = os.path.join(home, '.local', 'share', 'mise', 'installs')
        before_mise = size_of(installs)
        prune = [args.mise, 'prune', '--yes']
        if args.user:
            prune = ['runuser', '-u', args.user, '--', 'env', f'HOME={home}'] + prune
        command(prune, args.dry_run, 'mise_prune')
        reclaimed += max(0, before_mise - size_of(installs))
    if not args.home_only:
        command(['docker', 'image', 'prune', '--all', '--force', '--filter',
                 f'until={docker_age}h'], args.dry_run, 'docker_images')
        command(['docker', 'builder', 'prune', '--all', '--force', '--filter',
                 f'until={docker_age}h'], args.dry_run, 'docker_build_cache')
        command(['apt-get', 'clean'], args.dry_run, 'apt_cache')

    after = {p: free_bytes(p) for p in paths}
    log(event='finished', checkout_mib=freed // MIB,
        reclaimed_mib=reclaimed // MIB, dry_run=args.dry_run,
        free_mib={p: v // MIB for p, v in after.items()})


if __name__ == '__main__':
    main(sys.argv[1:])
