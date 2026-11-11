"""Command-line entry for `infra-cliproxy model-health` and `model-suite`."""

import argparse
import json
import os
import pathlib
import sys

from . import config as configuration
from . import findings
from . import report as reporting
from . import runner, simulate
from .emulator import Emulator

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]
EXIT = {"ok": 0, "failing": 1, "incomplete": 2, "usage": 3}


def resolve_key(config, offline):
    """Client key from the environment, an existing Vault login, or the installed host. Never printed."""
    if offline:
        return None
    value = os.environ.get(config.raw["endpoint"]["key_env"], "").strip()
    if value:
        return value
    sys.path.insert(0, str(SCRIPTS))
    token = os.environ.get("VAULT_TOKEN", "").strip()
    if token:
        import cloud_state

        try:
            return cloud_state.client_key(token)
        except Exception:
            return None
    import cliproxy_host

    root = cliproxy_host.default_root()
    try:
        return (root / "state/secrets/client-key").read_text().strip() or None
    except OSError:
        return None


def parser(default_profile):
    p = argparse.ArgumentParser(prog="infra-cliproxy model-suite" if default_profile == "nightly" else "infra-cliproxy model-health",
                                description=__doc__)
    p.add_argument("--profile", default=default_profile, choices=["liveness", "readiness", "light", "nightly", "manual"])
    p.add_argument("--suite", default="all", choices=["core", "cursor", "all"])
    p.add_argument("--target", default="live", choices=["live", "mock"],
                   help="mock runs the same declarative suite against the local emulator (no credentials, no spend)")
    p.add_argument("--base-url", help="Override the endpoint base URL (HTTPS required for live targets)")
    p.add_argument("--model", action="append", dest="models", metavar="MODEL_ID", help="Limit to a configured model id (repeatable)")
    p.add_argument("--config", help="Alternate models.json")
    p.add_argument("--output", metavar="DIR", help="Write model-health.json and model-health.md here")
    p.add_argument("--state", metavar="FILE", help="Persist last-success times here")
    p.add_argument("--check", action="append", dest="only", metavar="CAPABILITY",
                   help="Run only matching capabilities, for example chat.tools or 'responses.*' (repeatable); cheap reproduction")
    p.add_argument("--force-probe", action="store_true",
                   help="Probe models even if they were rate limited recently (normally paused to protect quota)")
    p.add_argument("--json", action="store_true", help="Print the JSON report instead of the human report")
    p.add_argument("--seed", type=int, help="Seed fixture tokens for reproducible requests")
    p.add_argument("--max-requests", type=int, help="Override the profile's total request budget")
    p.add_argument("--concurrency", type=int, help="Override the profile's model concurrency")
    p.add_argument("--timeout-scale", type=float, help="Multiply every timeout")
    p.add_argument("--fail-on", default="unhealthy", choices=["unhealthy", "degraded"])
    p.add_argument("--allow-unknown", action="store_true", help="Exit 0 when the result is unknown (for example no credentials)")
    return p


def write_reports(directory, report, text):
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "model-health.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (directory / "model-health.md").write_text(text + "\n")
    (directory / "agent-brief.md").write_text(findings.render_brief(report) + "\n")


def exit_code(status, fail_on, allow_unknown):
    if status == "unhealthy" or (status == "degraded" and fail_on == "degraded"):
        return EXIT["failing"]
    if status == "unknown" and not allow_unknown:
        return EXIT["incomplete"]
    return EXIT["ok"]


def main(argv, default_profile="light"):
    args = parser(default_profile).parse_args(argv)
    try:
        config = configuration.load(args.config)
    except (configuration.ConfigError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return EXIT["usage"]
    emulator = None
    base_url = args.base_url
    try:
        if args.target == "mock":
            emulator = Emulator([m["id"] for m in config.models])
            base_url = emulator.start()
            key = emulator.key
        else:
            key = resolve_key(config, offline=args.profile == "liveness")
        report = runner.run(
            config, args.profile, args.suite, base_url, key, args.target, args.models, args.seed, args.state,
            {"max_requests": args.max_requests, "concurrency": args.concurrency, "timeout_scale": args.timeout_scale},
            simulate=lambda: simulate.run_all(config, args.seed or 0), only=args.only, force_probe=args.force_probe,
        )
    except ValueError as error:
        print(error, file=sys.stderr)
        return EXIT["usage"]
    finally:
        if emulator:
            emulator.stop()
    text = reporting.render(report, config)
    if args.output:
        write_reports(args.output, report, text)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else text)
    return exit_code(report["summary"]["status"], args.fail_on, args.allow_unknown)
