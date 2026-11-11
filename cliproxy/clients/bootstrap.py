#!/usr/bin/env python3
"""Opt-in launchers, preserving all existing native client configuration."""

import hashlib
import subprocess
import argparse, getpass, json, os, pathlib, shutil, sys, urllib.request

p = argparse.ArgumentParser()
p.add_argument("--endpoint")
p.add_argument("--model")
p.add_argument("--claude-model")
p.add_argument("--uninstall", action="store_true")
p.add_argument("--validate", action="store_true")
a = p.parse_args()
launcher = pathlib.Path(__file__).resolve().with_name("launcher.py")
if not a.validate and not a.uninstall:
    try:
        source_repo = launcher.parents[2]
        tracked = subprocess.run(
            [
                "git",
                "-c",
                "safe.directory=" + str(source_repo),
                "-C",
                str(source_repo),
                "ls-files",
                "--error-unmatch",
                "--",
                "cliproxy/clients/bootstrap.py",
                "cliproxy/clients/launcher.py",
            ],
            capture_output=True,
        )
        if tracked.returncode or not launcher.is_file():
            raise ValueError("Untracked launcher")
    except (OSError, IndexError, ValueError):
        sys.exit(
            "Run bootstrap from the repository: bootstrap.py and launcher.py must be Git-tracked."
        )
home = pathlib.Path.home()
config = home / ".config/cliproxy-fleet"
bins = home / ".local/bin"
if a.uninstall:
    for name in ["codex-fleet", "claude-fleet", "opencode-fleet"]:
        f = bins / name
        if f.exists() and "cliproxy-fleet launcher" in f.read_text():
            f.unlink()
    # Keep the credential for deliberate reuse, not accidental credential loss.
    print(
        "Removed fleet launchers. Native settings unchanged. Remove ~/.config/cliproxy-fleet when no longer needed."
    )
    sys.exit()
os.umask(0o077)
config.mkdir(parents=True, exist_ok=True)
config.chmod(0o700)
bins.mkdir(parents=True, exist_ok=True)
if a.validate:
    settings = json.loads((config / "settings.json").read_text())
    key = (config / "client-key").read_text().strip()
    req = urllib.request.Request(
        settings["endpoint"].rstrip("/") + "/v1/models",
        headers={"Authorization": "Bearer " + key, "User-Agent": "cliproxy-fleet/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    print("Authenticated model listing passed; model IDs:")
    print("\n".join(m["id"] for m in data.get("data", [])))
    sys.exit()
if not a.endpoint or not a.model:
    p.error("--endpoint and --model are required; choose actual available model IDs")
if not a.endpoint.startswith("https://"):
    p.error("Endpoint must use HTTPS")
previous = (
    json.loads((config / "settings.json").read_text())
    if (config / "settings.json").exists()
    else {}
)
generator_sha256 = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
settings = {
    "endpoint": a.endpoint.rstrip("/"),
    "generator_repository": "https://github.com/crvouga/dev-fleet",
    "generator_sha256": generator_sha256,
    "model": a.model,
    "claude_model": a.claude_model or previous.get("claude_model"),
}
keyfile = config / "client-key"
if not keyfile.exists():
    key = getpass.getpass(
        "Fleet client API key (hidden; NOT provider OAuth or management key): "
    )
    if len(key) < 32:
        sys.exit("Client key must contain at least 32 characters")
    keyfile.write_text(key + "\n")
    keyfile.chmod(0o600)
(config / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
# Use SDK-specific protocols; users select the launcher explicitly.
opencode = {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
        "fleet-responses": {
            "npm": "@ai-sdk/openai",
            "name": "Fleet (Responses)",
            "options": {
                "baseURL": settings["endpoint"] + "/v1",
                "apiKey": "{env:CLIPROXY_API_KEY}",
            },
            "models": {a.model: {"name": a.model}},
        },
        "fleet-claude": {
            "npm": "@ai-sdk/anthropic",
            "name": "Fleet (Claude)",
            "options": {
                "baseURL": settings["endpoint"] + "/v1",
                "apiKey": "{env:CLIPROXY_API_KEY}",
            },
            "models": {a.claude_model: {"name": a.claude_model}},
        },
    },
    "model": "fleet-responses/" + a.model,
}
if not settings["claude_model"]:
    opencode["provider"].pop("fleet-claude")
else:
    opencode["provider"]["fleet-claude"]["models"] = {
        settings["claude_model"]: {"name": settings["claude_model"]}
    }
(config / "opencode.json").write_text(json.dumps(opencode, indent=2) + "\n")
launcher = pathlib.Path(__file__).resolve().with_name("launcher.py")
if not launcher.is_file():
    sys.exit(
        "Run bootstrap from the repository checkout; tracked launcher.py is required."
    )

for name in ["codex-fleet", "claude-fleet", "opencode-fleet"]:
    f = bins / name
    if f.exists() and "cliproxy-fleet launcher" not in f.read_text():
        sys.exit("Refusing to overwrite unrelated launcher: " + str(f))
    if f.exists() or f.is_symlink():
        f.unlink()
    f.symlink_to(launcher)
print(
    "Installed opt-in launchers in ~/.local/bin. Native client settings preserved. Run bootstrap.py --validate."
)
