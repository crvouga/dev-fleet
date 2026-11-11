"""Bound disposable history. Call only while holding state/status/operation.lock."""

import datetime
import json
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cliproxy_host


def forget(restic):
    # Do not group by random staging paths or format-version tags: both grow forever.
    restic(
        "forget",
        "--tag",
        "cliproxy-fleet",
        "--host",
        "cliproxy-primary",
        "--group-by",
        "host",
        "--keep-last",
        "96",
        "--keep-daily",
        "7",
        "--keep-weekly",
        "5",
        "--keep-monthly",
        "12",
    )


def prune(restic, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    result = restic(
        "snapshots",
        "--json",
        "--tag",
        "cliproxy-checkpoint-v1",
        "--host",
        "cliproxy-primary",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    snapshots = json.loads(result.stdout)
    times = [
        datetime.datetime.fromisoformat(item["time"].replace("Z", "+00:00"))
        for item in snapshots
    ]
    if not times or not 0 <= (now - max(times)).total_seconds() <= 3600:
        raise ValueError(
            "A successful cloud checkpoint within one hour is required for GC"
        )
    restic(
        "check"
    )  # Never delete history from a repository already failing integrity checks.
    forget(restic)
    # Physical collection applies only inside this dedicated Restic repository.
    # No repack cap: a cap could let garbage arrive faster than it is reclaimed.
    restic("prune", "--max-unused", "5%")
    restic("check")


def staging(root, now=None):
    now = time.time() if now is None else now
    recovery = root / "recovery"
    if not recovery.exists():
        return 0
    if recovery.is_symlink():
        raise ValueError("Recovery directory must not be a link")
    removed = 0
    for path in recovery.iterdir():
        if not re.fullmatch(r"(?:checkpoint|restore)-[a-z0-9_]{8}", path.name):
            continue
        metadata = path.lstat()
        if stat.S_ISDIR(metadata.st_mode) and now - metadata.st_mtime > 86400:
            # Python's fd-based rmtree does not traverse symlinks inside the tree.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise ValueError("Safe directory deletion unavailable")
            shutil.rmtree(path)
            removed += 1
    return removed


def revisions(root, references=None):
    """Retain current and previous installed Git revisions; never force removal."""
    current = json.loads((root / "INSTALLATION.json").read_text())
    previous = root / "INSTALLATION.previous.json"
    keep = {current["revision"]}
    if previous.exists():
        keep.add(json.loads(previous.read_text())["revision"])
    parent = root / "revisions"
    if references is None:
        home = cliproxy_host.runtime_home()
        units = cliproxy_host.backend().unit_directory
        references = [
            *(home / ".local/bin").glob("*-fleet"),
            *units.glob("cliproxy-*"),
            *units.glob("dev.devfleet.cliproxy-*"),
        ]
    for reference in references:
        if reference.is_symlink():
            try:
                keep.add(reference.resolve().relative_to(parent.resolve()).parts[0])
            except ValueError:
                pass
    active = parent / current["revision"]
    if parent.is_symlink() or active.is_symlink() or not active.is_dir():
        raise ValueError("Invalid installed worktree directory")

    def git(path, *args):
        return subprocess.check_output(
            [
                "git",
                "--no-optional-locks",
                "-c",
                "safe.directory=" + str(path),
                "-C",
                str(path),
                *args,
            ],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()

    removed = 0
    for path in parent.iterdir():
        if path.name in keep or not re.fullmatch(r"[0-9a-f]{40}", path.name):
            continue
        if path.is_symlink() or not path.is_dir():
            continue
        if git(path, "rev-parse", "HEAD") != path.name:
            raise ValueError("Unexpected worktree revision")
        if git(path, "status", "--porcelain", "--untracked-files=all", "--ignored"):
            raise ValueError("Retired worktree has changes; refusing deletion")
        git(active, "worktree", "remove", str(path))
        removed += 1
    return removed
