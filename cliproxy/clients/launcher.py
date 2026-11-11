#!/usr/bin/env python3
# cliproxy-fleet launcher
# Tracked source: crvouga/dev-fleet cliproxy/clients/launcher.py
import json, os, pathlib, sys

r = pathlib.Path.home() / ".config/cliproxy-fleet"
s = json.loads((r / "settings.json").read_text())
os.environ["CLIPROXY_API_KEY"] = (r / "client-key").read_text().strip()
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "codex-fleet":
    args = [
        "codex",
        "-c",
        'model_provider="fleet"',
        "-c",
        'model_providers.fleet.name="Fleet"',
        "-c",
        "model_providers.fleet.base_url=" + json.dumps(s["endpoint"] + "/v1"),
        "-c",
        'model_providers.fleet.env_key="CLIPROXY_API_KEY"',
        "-c",
        'model_providers.fleet.wire_api="responses"',
        "-c",
        "model_providers.fleet.requires_openai_auth=false",
        "-c",
        "model_providers.fleet.supports_websockets=false",
        "-m",
        s["model"],
        *args,
    ]
elif name == "claude-fleet":
    if not s.get("claude_model"):
        sys.exit(
            "No Claude model configured. Add an authorized Claude account and rerun bootstrap with --claude-model MODEL_ID."
        )
    for k in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ]:
        os.environ.pop(k, None)
    os.environ["ANTHROPIC_BASE_URL"] = s["endpoint"]
    os.environ["ANTHROPIC_AUTH_TOKEN"] = os.environ["CLIPROXY_API_KEY"]
    # Pin all default model families to the explicit approved model; no cost-changing fallback.
    for k in [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ]:
        os.environ[k] = s["claude_model"]
    args = ["claude", "--model", s["claude_model"], *args]
else:
    os.environ["OPENCODE_CONFIG"] = str(r / "opencode.json")
    args = ["opencode", *args]
os.execvp(args[0], args)
