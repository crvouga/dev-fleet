#!/usr/bin/env python3
"""Require runtime code and unit links to resolve to clean, Git-tracked files."""

import sys

sys.dont_write_bytecode = True

import pathlib as _pathlib

sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
import cliproxy_host

import hashlib
import json
import os
import pathlib
import subprocess
import sys


def quiet(args):
    try:
        return (
            subprocess.run(
                args, capture_output=True, timeout=30, check=False
            ).returncode
            == 0
        )
    except (OSError, subprocess.TimeoutExpired):
        return False


def audit(root, check_units=True, backend=None, run=quiet):
    """Check provenance; with check_units, also the platform's unit links (and,
    for launchd, that the required agents are loaded in gui/$UID)."""
    manifest = json.loads((root / "INSTALLATION.json").read_text())
    errors = []
    if manifest.get("schema_version") != 2:
        return manifest, [
            "legacy copied-code installation; reinstall from the repository"
        ]
    worktree = pathlib.Path(manifest["worktree"])
    command = [
        "git",
        "--no-optional-locks",
        "-c",
        "safe.directory=" + str(worktree),
        "-C",
        str(worktree),
    ]
    revision = (
        subprocess.check_output(command + ["rev-parse", "HEAD"], stderr=subprocess.PIPE)
        .decode()
        .strip()
    )
    tracked = set(
        subprocess.check_output(
            command + ["ls-files", "-z", "--", manifest["package"]],
            stderr=subprocess.PIPE,
        )
        .decode()
        .strip("\0")
        .split("\0")
    )
    if revision != manifest["revision"]:
        errors.append("deployment worktree revision")
    if subprocess.check_output(
        command + ["status", "--porcelain", "--", manifest["package"]],
        stderr=subprocess.PIPE,
    ).strip():
        errors.append("deployment worktree has local changes")
    # Resolve once: macOS temporary/home paths may route through symlinks.
    source = worktree.resolve() / manifest["package"]
    units = (backend or cliproxy_host.backend()) if check_units else None
    for name, expected in manifest["files"].items():
        path = root / name
        if (
            manifest["package"] + "/" + name not in tracked
            or not path.is_file()
            or path.resolve() != source / name
            or hashlib.sha256(path.read_bytes()).hexdigest() != expected
        ):
            errors.append(name)
        if units and name.startswith(units.source_directory + "/"):
            unit = units.unit_directory / path.name
            if not unit.is_symlink() or unit.resolve() != source / name:
                errors.append(str(unit))
    for name, expected in manifest["generated"].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            errors.append(name)
    if units and units.name == "launchd":
        required = [units.service, *units.scheduled]
        if not (root / "state/secrets/recovery-confirmed").exists():
            required = [label for label in required if label not in units.recovery_gated]
        for label in required:
            if not units.loaded(label, run):
                errors.append("not loaded: " + units.domain + "/" + label)
    for folder in ["scripts", "clients", "systemd", "launchd"]:
        for path in (root / folder).rglob("*"):
            if (
                (root / folder).is_dir()
                and path.is_file()
                and "__pycache__" not in path.parts
                and str(path.relative_to(root)) not in manifest["files"]
            ):
                errors.append("unmanaged: " + str(path.relative_to(root)))
    return manifest, errors


if __name__ == "__main__":
    try:
        manifest, errors = audit(cliproxy_host.default_root())
        if errors:
            print("Code is not clean tracked repository source: " + ", ".join(errors))
            sys.exit(1)
        print(
            "Runtime code is Git-tracked at crvouga/dev-fleet commit "
            + manifest["revision"]
        )
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        sys.exit(
            "Git source unavailable or provenance invalid; reinstall from the repository."
        )
