#!/usr/bin/env python3
"""Explicit live checks; never included in offline CI or activate restored credentials."""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile


def run(args, **kwargs):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=180, **kwargs
    )


def check_codex(root, endpoint):
    with tempfile.TemporaryDirectory(prefix="cliproxy-codex-check-") as directory:
        temporary = pathlib.Path(directory)
        (temporary / "probe.txt").write_text("fleet-proxy-tool-check-OK\n")
        (temporary / "codex-home").mkdir()
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(temporary / "codex-home")
        environment["CLIPROXY_API_KEY"] = (
            (root / "state/secrets/client-key").read_text().strip()
        )
        args = [
            "codex",
            "-c",
            'model_provider="fleet"',
            "-c",
            'model_providers.fleet.name="Fleet"',
            "-c",
            "model_providers.fleet.base_url=" + json.dumps(endpoint + "/v1"),
            "-c",
            'model_providers.fleet.env_key="CLIPROXY_API_KEY"',
            "-c",
            'model_providers.fleet.wire_api="responses"',
            "-c",
            "model_providers.fleet.requires_openai_auth=false",
            "-c",
            "model_providers.fleet.supports_websockets=false",
            "-c",
            'model_reasoning_effort="low"',
            "-m",
            "gpt-6.1-sol",
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--json",
            "Read probe.txt with a shell tool and reply with its exact contents. Do not modify files.",
        ]
        result = run(args, env=environment, cwd=temporary)
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        assert "fleet-proxy-tool-check-OK" in result.stdout
        assert any(
            event.get("item", {}).get("type") == "command_execution" for event in events
        )
    print(
        "PASS: actual Codex Responses stream, shell-tool round trip and final text over the configured HTTPS endpoint."
    )


def check_opencode(root, endpoint):
    with tempfile.TemporaryDirectory(prefix="cliproxy-opencode-check-") as directory:
        temporary = pathlib.Path(directory)
        environment = os.environ.copy()
        for name in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
        ]:
            path = temporary / name
            path.mkdir()
            environment[name] = str(path)
        environment["CLIPROXY_API_KEY"] = (
            (root / "state/secrets/client-key").read_text().strip()
        )
        config = temporary / "opencode.json"
        config.write_text(
            json.dumps(
                {
                    "provider": {
                        "fleet-responses": {
                            "npm": "@ai-sdk/openai",
                            "name": "Fleet",
                            "options": {
                                "baseURL": endpoint + "/v1",
                                "apiKey": "{env:CLIPROXY_API_KEY}",
                            },
                            "models": {"gpt-6.1-sol": {"name": "gpt-6.1-sol"}},
                        }
                    }
                }
            )
        )
        environment["OPENCODE_CONFIG"] = str(config)
        result = run(
            [
                "opencode",
                "run",
                "--pure",
                "--format",
                "json",
                "-m",
                "fleet-responses/gpt-6.1-sol",
                "Reply only fleet-opencode-OK. Do not call tools.",
            ],
            env=environment,
            cwd=temporary,
        )
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        assert not any(event.get("type") == "error" for event in events)
        assert any(
            event.get("type") == "text"
            and "fleet-opencode-OK" in event.get("part", {}).get("text", "")
            for event in events
        )
    print(
        "PASS: actual OpenCode Responses stream and final text over the configured HTTPS endpoint."
    )


def check_recovery(root, restore):
    with tempfile.TemporaryDirectory(prefix="cliproxy-cloud-recovery-") as directory:
        temporary = pathlib.Path(directory)
        tooling = temporary / "tooling"
        tooling.mkdir()
        (tooling / "scripts").symlink_to(
            (root / "scripts").resolve(), target_is_directory=True
        )
        (tooling / "state/secrets").mkdir(parents=True, mode=0o700)
        shutil.copyfile(
            root / "state/secrets/vault-token", tooling / "state/secrets/vault-token"
        )
        environment = os.environ.copy()
        environment["CLIPROXY_ROOT"] = str(tooling)
        run([str(tooling / "scripts/vault-recovery"), "recover"], env=environment)
        run([str(tooling / "scripts/backup"), "snapshots"], env=environment)
        if restore:
            target = temporary / "restored"
            run(
                [str(tooling / "scripts/backup"), "restore", "latest", str(target)],
                env=environment,
            )
            restored = target
            run(
                [str(root / "scripts/restore-verify"), str(restored)],
                env=environment,
            )
            # Exercise the same empty-cache publisher used on a replacement host.
            import importlib.util

            spec = importlib.util.spec_from_file_location(
                "checkpoint", root / "scripts/checkpoint.py"
            )
            checkpoint = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(checkpoint)
            cache = temporary / "replacement/state"
            cache.mkdir(parents=True)
            checkpoint.hydrate(checkpoint.locate(restored), cache)
            assert (cache / "runtime/config.yaml").is_file()
            assert not (cache / "recovery-incomplete").exists()
    print(
        "PASS: independently recovered Vault password decrypts R2; restored credentials remain unactivated."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--endpoint", help="Explicit HTTPS origin for client verification"
    )
    parser.add_argument("--codex", action="store_true")
    parser.add_argument("--opencode", action="store_true")
    parser.add_argument("--recovery", action="store_true")
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    if not any([args.codex, args.opencode, args.recovery, args.restore]):
        parser.error(
            "Select live checks explicitly. Inference checks consume a small number of provider tokens."
        )
    os.umask(0o077)
    root = pathlib.Path(
        os.environ.get("CLIPROXY_ROOT", "/opt/cliproxy-fleet")
    ).resolve()
    endpoint = (
        args.endpoint
        or json.loads((root / "state/endpoint.json").read_text())["endpoint"]
    )
    try:
        if args.codex:
            check_codex(root, endpoint)
        if args.opencode:
            check_opencode(root, endpoint)
        if args.recovery or args.restore:
            check_recovery(root, args.restore)
    except Exception:
        raise SystemExit(
            "Live verification failed; child output and secret values suppressed."
        ) from None


if __name__ == "__main__":
    main()
