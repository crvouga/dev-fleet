#!/usr/bin/env python3
"""Prepare a complete offline node cache atomically; never stop/start the live stack."""

import sys

sys.dont_write_bytecode = True

import pathlib as _pathlib

sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
import cliproxy_host

import argparse
import ctypes
import datetime
import json
import os
import pathlib
import stat
import shutil
import subprocess
import tempfile
import checkpoint
import cloud_state


def publish(candidate, destination):
    """Atomic directory publication with no replacement, including races."""
    library = ctypes.CDLL(None, use_errno=True)
    if cliproxy_host.system() == "macos":
        # renamex_np(from, to, RENAME_EXCL)
        rename = library.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        arguments = [os.fsencode(candidate), os.fsencode(destination), 0x4]
    else:
        # renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE)
        rename = library.renameat2
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        arguments = [-100, os.fsencode(candidate), -100, os.fsencode(destination), 1]
    rename.restype = ctypes.c_int
    if rename(*arguments) != 0:
        raise OSError(ctypes.get_errno(), "Recovery destination could not be published")


def verify_source(payload):
    subprocess.run(
        [
            sys.executable,
            "-B",
            str(pathlib.Path(__file__).parent / "restore-verify"),
            str(payload),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )


def recover(
    destination,
    token_path,
    restic_factory=cloud_state.client,
    read_settings=cloud_state.settings,
):
    # Refuse even an empty existing directory: no user data or deployment can be overwritten.
    live_root = cliproxy_host.default_root().resolve()
    canonical_destination = destination.parent.resolve() / destination.name
    if live_root.exists() and canonical_destination.is_relative_to(live_root):
        raise ValueError("Recovery destination must be outside the existing deployment")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Recovery destination already exists")
    if not destination.parent.is_dir():
        raise ValueError("Recovery parent directory must exist")
    metadata = token_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ValueError("Vault token must be a private regular file")
    token = token_path.read_text().strip()
    if not token:
        raise ValueError("Existing Vault login required")
    data = read_settings(token)
    restic = restic_factory(data)
    snapshot = cloud_state.latest(restic)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(
        prefix=".cliproxy-recover-", dir=destination.parent
    ) as directory:
        staging = pathlib.Path(directory)
        restored = staging / "restored"
        restic("restore", snapshot["id"], "--target", str(restored), "--verify")
        payload = checkpoint.locate(restored)
        # Validate the source manifest against trusted Git objects, never run restored code.
        verify_source(payload)
        repository = json.loads((payload / "state/repository.json").read_text())
        if repository != {
            key: data[key] for key in ("S3_ENDPOINT", "S3_BUCKET", "S3_REGION")
        }:
            raise ValueError("Recovered repository identity differs from Vault")
        import yaml

        config = yaml.safe_load((payload / "state/runtime/config.yaml").read_text())
        if data["CLIPROXY_FLEET_CLIENT_API_KEY"] not in config["access"]["api-keys"]:
            raise ValueError("Checkpoint client key differs from current Vault key")
        candidate = staging / "candidate"
        state = candidate / "state"
        state.mkdir(parents=True, mode=0o700)
        checkpoint.hydrate(payload, state)
        secrets = state / "secrets"
        secrets.mkdir(mode=0o700)
        values = {
            "vault-token": token,
            "client-key": data["CLIPROXY_FLEET_CLIENT_API_KEY"],
            "management-key": data["CLIPROXY_FLEET_MANAGEMENT_KEY"],
            "restic-password": data["CLIPROXY_FLEET_RESTIC_PASSWORD"],
            "recovery-confirmed": "Recovered independently from Vault.",
        }
        for name, value in values.items():
            file = secrets / name
            file.write_text(value + "\n")
            file.chmod(0o600)
        (state / "status").mkdir(mode=0o700)
        gc_status = payload / "state/status/gc-success.json"
        if gc_status.is_file():
            shutil.copyfile(gc_status, state / "status/gc-success.json")
        source = json.loads((payload / "INSTALLATION.json").read_text())
        (candidate / "RECOVERY.json").write_text(
            json.dumps(
                {
                    "snapshot": snapshot["id"],
                    "source_revision": source["revision"],
                    "recovered_at": datetime.datetime.now(
                        datetime.timezone.utc
                    ).isoformat(),
                    "activated": False,
                }
            )
            + "\n"
        )
        publish(candidate, destination)
    return snapshot["id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "destination",
        type=pathlib.Path,
        help="New, nonexistent deployment/cache directory",
    )
    parser.add_argument(
        "--vault-token-file",
        type=pathlib.Path,
        default=cliproxy_host.default_root()
        / "state/secrets/vault-token",
    )
    args = parser.parse_args()
    # Do not resolve the final component: an existing dangling symlink must be refused.
    destination = args.destination.absolute()
    recover(destination, args.vault_token_file)
    print("Verified cloud recovery prepared at", destination)
    print(
        "No services or provider identities activated. RECOVERY.json records the source revision."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(
            "Offline recovery failed; live deployment unchanged. Credentials and upstream responses suppressed."
        ) from None
