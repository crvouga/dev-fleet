"""Consistent, secret-minimal checkpoints. Runtime state is never executable code."""

import fnmatch
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import time

STATE_PATHS = (
    "runtime/config.yaml",
    "runtime/auths",
    "runtime/static/management.html",
    "tailscale",
    "endpoint.json",
    "public-endpoint-enabled",
    "repository.json",
    "status/gc-success.json",
)


def regular_tree(path):
    """Reject links/devices before copying or publishing recovered state."""
    mode = path.lstat().st_mode
    if stat.S_ISDIR(mode):
        for child in path.iterdir():
            regular_tree(child)
    elif not stat.S_ISREG(mode):
        raise ValueError("Checkpoint must contain only regular files/directories")


def hashes(root):
    regular_tree(root)
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and path != root / "CHECKPOINT.json"
    }


# Upstream writes these beside credentials; they are never checkpointed.
AUTH_TRANSIENT = ("*.lock", "logs")


def validate(root):
    regular_tree(root)
    manifest = json.loads((root / "CHECKPOINT.json").read_text())
    if manifest.get("version") != 1 or manifest.get("files") != hashes(root):
        raise ValueError("Checkpoint incomplete or changed")
    state = root / "state"
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        name = str(path.relative_to(root))
        if name in ("CHECKPOINT.json", "INSTALLATION.json"):
            continue
        if not any(
            name == "state/" + allowed or name.startswith("state/" + allowed + "/")
            for allowed in STATE_PATHS
        ):
            raise ValueError("Unexpected checkpoint file")
    if not (state / "runtime/static/management.html").is_file():
        raise ValueError("Dashboard missing")
    if not (state / "runtime/auths").is_dir():
        raise ValueError("Provider cache directory missing")
    for path in (state / "runtime/auths").iterdir():
        if path.name == "kv.db" and path.is_file() and path.stat().st_size > 0:
            continue  # Opaque upstream bbolt state, captured while the process is stopped.
        # .json: provider credential; .cds: upstream per-account cooldown
        # records (JSON object, no credential), kept so limits survive moves.
        if path.suffix not in (".json", ".cds") or not path.is_file():
            raise ValueError("Unexpected provider file")
        if not isinstance(json.loads(path.read_text()), dict):
            raise ValueError("Provider credential must be an object")
    subprocess.run(
        [
            str(pathlib.Path(__file__).parent / "validate-config"),
            str(state / "runtime/config.yaml"),
        ],
        check=True,
        capture_output=True,
    )
    return manifest


def stamps(root):
    """Size and modification time of every state file whose copy must be whole:
    the runtime tree and the Tailscale identity. Changing logs are not state."""
    found = {}
    for name in ("runtime", "tailscale/tailscaled.state"):
        source = root / "state" / name
        paths = [source] if source.is_file() else source.rglob("*") if source.is_dir() else []
        for path in paths:
            if path.is_file() and not any(
                fnmatch.fnmatch(part, pattern)
                for part in path.relative_to(root).parts
                for pattern in AUTH_TRANSIENT
            ):
                status = path.stat()
                found[str(path)] = (status.st_size, status.st_mtime_ns)
    return found


def copy_state(root, target):
    target.mkdir(mode=0o700)
    (target / "state").mkdir(mode=0o700)
    for name in STATE_PATHS:
        source = root / "state" / name
        if not source.exists() and not source.is_symlink():
            continue
        regular_tree(source)
        destination = target / "state" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            # Process-local locks and upstream error logs (request
            # content) are never restored.
            ignore = (
                shutil.ignore_patterns(*AUTH_TRANSIENT)
                if name == "runtime/auths"
                else None
            )
            shutil.copytree(source, destination, ignore=ignore)
        else:
            shutil.copyfile(source, destination)
    shutil.copyfile(root / "INSTALLATION.json", target / "INSTALLATION.json")
    (target / "CHECKPOINT.json").write_text(
        json.dumps(
            {
                "version": 1,
                "files": hashes(target),
                "tokens": _accounts().token_digests(target / "state/runtime/auths"),
            }
        )
        + "\n"
    )
    validate(target)


def _accounts():
    """accounts.py beside this file, however this module was loaded."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "accounts", pathlib.Path(__file__).resolve().parent / "accounts.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stale_accounts(restored, newest):
    """[(provider, index)] of the accounts in the restored checkpoint
    `restored` whose refresh token the provider has since replaced, judged
    against the manifest of the newest checkpoint `newest`. Restoring the
    newest checkpoint itself finds none."""
    tokens = json.loads((newest / "CHECKPOINT.json").read_text()).get("tokens") or {}
    return _accounts().stale_after_restore(restored / "state/runtime/auths", tokens)


def capture(root, target, attempts=6, sleep=time.sleep):
    """Copies the state of the running stack without ever stopping it: agents
    use the proxy around the clock, and a stopped connector fails every one of
    their requests. A copy is consistent when no state file changed while it
    was taken (the proxy writes a file, including its bbolt store, in one
    synced step); otherwise it is discarded and taken again. A stack that
    never holds still fails the backup, which the monitor reports."""
    for attempt in range(attempts):
        before = stamps(root)
        try:
            copy_state(root, target)
            if stamps(root) == before:
                return
        except (OSError, ValueError):
            # A file replaced mid-copy; only the last attempt's error counts.
            if attempt + 1 == attempts:
                shutil.rmtree(target, ignore_errors=True)
                raise
        shutil.rmtree(target, ignore_errors=True)
        sleep(2)
    raise ValueError("State kept changing during capture")


def locate(restored):
    """Restic retains the source absolute path; never assume a source hostname/path."""
    candidates = list(restored.rglob("CHECKPOINT.json"))
    if len(candidates) != 1:
        raise ValueError(
            "Expected exactly one modern checkpoint; use manual legacy recovery"
        )
    root = candidates[0].parent
    validate(root)
    return root


def hydrate(checkpoint, state):
    """Populate an empty cache only. A crash marker prevents partial-cache startup."""
    validate(checkpoint)
    names = (
        "runtime",
        "tailscale",
        "endpoint.json",
        "public-endpoint-enabled",
        "repository.json",
    )
    repository = state / "repository.json"
    if repository.exists() or repository.is_symlink():
        regular_tree(repository)
        saved = checkpoint / "state/repository.json"
        if not saved.is_file() or json.loads(repository.read_text()) != json.loads(
            saved.read_text()
        ):
            raise ValueError("Existing repository identity differs from checkpoint")
        names = tuple(name for name in names if name != "repository.json")
    if any((state / name).exists() or (state / name).is_symlink() for name in names):
        raise ValueError(
            "Recovery requires an empty cache; preserve or remove existing cache explicitly"
        )
    marker = state / "recovery-incomplete"
    if marker.exists():
        raise ValueError("Interrupted recovery requires inspection")
    marker.write_text("Recovery in progress; do not start services.\n")
    created = []
    try:
        for name in names:
            source = checkpoint / "state" / name
            if not source.exists():
                continue
            destination = state / name
            created.append(destination)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copyfile(source, destination)
            paths = (
                [destination, *destination.rglob("*")]
                if destination.is_dir()
                else [destination]
            )
            for path in paths:
                path.chmod(0o700 if path.is_dir() else 0o600)
                if os.geteuid() == 0:
                    os.chown(path, 1000, 1000)
        marker.unlink()
    except BaseException:
        for destination in reversed(created):
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink(missing_ok=True)
        marker.unlink()
        raise
