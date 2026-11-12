#!/usr/bin/python3
"""Push work in progress of every agent worktree to a recovery ref.

Managed by personal fleet-sync (tasks/recovery.yml) as
personal-worker-wip-guard.service, started by personal-worker-wip-guard.timer.

Workers are disposable: a worker lost mid-task must lose at most one interval
of uncommitted work. For each Git worktree under --root, the files as they are
now (tracked changes and untracked files that are not ignored) are written as
one commit on top of HEAD, built in a private index so the worktree, its index
and its branches are never touched, and pushed to

    refs/recovery/<node>/<branch>

of the worktree's own remote. A clean worktree whose HEAD is already on a
remote branch has nothing to recover and pushes nothing. Recover with
`git fetch origin 'refs/recovery/*:refs/recovery/*'`.

Every decision is one JSON line on stdout.

Usage: wip-guard.py --root DIR [--root DIR ...] [--node ID] [--remote NAME]
                    [--max-depth N] [--dry-run]
"""
import argparse
import json
import os
import re
import socket
import subprocess
import tempfile
from pathlib import Path

GIT = ['git', '-c', 'safe.directory=*']
AUTHOR = {
    'GIT_AUTHOR_NAME': 'dev-fleet work-in-progress guard',
    'GIT_AUTHOR_EMAIL': 'wip-guard@example.invalid',
    'GIT_COMMITTER_NAME': 'dev-fleet work-in-progress guard',
    'GIT_COMMITTER_EMAIL': 'wip-guard@example.invalid',
}


def log(**event):
    print(json.dumps(event, sort_keys=True), flush=True)


def git(path, *args, env=None):
    return subprocess.run(
        [*GIT, '-C', str(path), *args], capture_output=True, text=True,
        env={**os.environ, **(env or {})}, timeout=120)


def worktrees(root, depth):
    if depth < 0 or not root.is_dir() or root.is_symlink():
        return
    if (root / '.git').exists():
        yield root
        return
    for child in sorted(root.iterdir()):
        if child.is_dir() and not child.is_symlink():
            yield from worktrees(child, depth - 1)


def ref_part(value):
    part = re.sub(r'[^A-Za-z0-9._/-]+', '-', value).strip('./-')
    part = re.sub(r'/+', '/', part).replace('..', '.')
    return part or 'unnamed'


def snapshot(path):
    """The worktree's files as one commit on HEAD, or HEAD when clean."""
    head = git(path, 'rev-parse', '--verify', 'HEAD').stdout.strip()
    if not head:
        return None, None
    with tempfile.TemporaryDirectory() as private:
        index = {'GIT_INDEX_FILE': os.path.join(private, 'index')}
        if git(path, 'read-tree', 'HEAD', env=index).returncode != 0:
            return head, None
        if git(path, 'add', '--all', '--', '.', env=index).returncode != 0:
            return head, None
        tree = git(path, 'write-tree', env=index).stdout.strip()
    if tree == git(path, 'rev-parse', 'HEAD^{tree}').stdout.strip():
        return head, head
    commit = git(path, 'commit-tree', tree, '-p', head, '-m',
                 'Work in progress saved by the dev-fleet guard', env=AUTHOR)
    return head, commit.stdout.strip() or None


def guard(path, node, remote, dry_run):
    if git(path, 'remote', 'get-url', remote).returncode != 0:
        return log(worktree=str(path), action='skip', reason='no-remote')
    head, commit = snapshot(path)
    if not commit:
        return log(worktree=str(path), action='skip', reason='no-commit')
    if commit == head and git(path, 'branch', '--remotes', '--contains', head).stdout.strip():
        return log(worktree=str(path), action='skip', reason='clean')
    branch = git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD').stdout.strip()
    ref = 'refs/recovery/%s/%s' % (ref_part(node), ref_part(branch or 'detached-' + head[:12]))
    if dry_run:
        return log(worktree=str(path), action='would-push', ref=ref)
    pushed = git(path, 'push', '--force', '--no-verify', '--quiet', remote, '%s:%s' % (commit, ref))
    log(worktree=str(path), action='pushed' if pushed.returncode == 0 else 'failed', ref=ref)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', action='append', required=True)
    parser.add_argument('--node', default=socket.gethostname().split('.')[0])
    parser.add_argument('--remote', default='origin')
    parser.add_argument('--max-depth', type=int, default=3)
    parser.add_argument('--dry-run', action='store_true')
    options = parser.parse_args()
    for root in options.root:
        for path in worktrees(Path(root).expanduser(), options.max_depth):
            try:
                guard(path, options.node, options.remote, options.dry_run)
            except (OSError, subprocess.SubprocessError):
                log(worktree=str(path), action='failed', reason='git')


if __name__ == '__main__':
    main()
