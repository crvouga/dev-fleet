#!/usr/bin/env python3
"""Repository entry point for installing and operating the local service."""

import sys

sys.dont_write_bytecode = True

import pathlib as _pathlib

sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
import cliproxy_host


import os
import pathlib
import subprocess
import sys

source = pathlib.Path(__file__).resolve().parent
root = cliproxy_host.default_root().resolve()
args = sys.argv[1:]
if not args or args[0] in ["help", "--help", "-h"]:
    print(
        "Usage: devfleet cliproxy COMMAND\nCommands: install [--revision REV|--rollback|--dry-run|--prepare-only], audit, public-endpoint [enable|start|disable|verify], status, start, stop, restart, health, models, logs, validate, apply FILE, add-account PROVIDER, relogin PROVIDER INDEX, remove-account PROVIDER INDEX, accounts [--json], client-keys, issue-key|rotate-key|retire-key|revoke-key NODE, inference PROTOCOL MODEL, model-health [--profile liveness|readiness|light|nightly|manual] [--suite core|cursor|all] [--target live|mock], model-suite (same flags; defaults to nightly), backup, gc, snapshots, check, check-full, restore SNAPSHOT EMPTY_DIRECTORY, restore-cache --previous-node-stopped, vault-login, recover, recover-node NEW_DIRECTORY [--vault-token-file FILE], verify-recovery, portable-login, activate, drain"
    )
    sys.exit(0)
command, *rest = args
if command == "install":
    invocation = [sys.executable, str(source / "install.py"), *rest]
    # The legacy Linux host installs system units; the macOS manager is per-user.
    linux = cliproxy_host.system() == "linux"
    if linux and os.geteuid() != 0 and "--dry-run" not in rest:
        invocation = ["sudo", *invocation]
elif command in ["model-health", "model-suite"]:
    invocation = [sys.executable, "-B", str(source / "model_health.py"), command, *rest]
elif command == "recover-node":
    invocation = [sys.executable, "-B", str(root / "scripts/recover_node.py"), *rest]
elif command == "public-endpoint":
    invocation = [str(root / "scripts/public-endpoint"), *rest]
elif command == "audit":
    invocation = [sys.executable, str(root / "scripts/audit.py"), *rest]
elif command in [
    "backup",
    "gc",
    "snapshots",
    "check",
    "check-full",
    "restore",
    "restore-cache",
]:
    invocation = [str(root / "scripts/backup"), command, *rest]
elif command in ["vault-login", "recover", "verify-recovery"]:
    invocation = [
        str(
            root
            / "scripts"
            / ("vault-backup-login" if command == "vault-login" else "vault-recovery")
        )
    ]
    if command != "vault-login":
        invocation.append("recover" if command == "recover" else "verify")
else:
    invocation = [str(root / "scripts/ops"), command, *rest]
raise SystemExit(subprocess.call(invocation))
