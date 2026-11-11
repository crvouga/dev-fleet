"""Turn a health report into findings an agent (or human) can act on without re-deriving context.

Each finding names what failed, who can fix it, the evidence (structural trace, never prompt text),
the exact command that reproduces it cheaply, and where in the repository the fix would go.
"""

import hashlib

# category -> (owner, who can resolve it)
OWNERS = {
    "credentials": ("credentials", "operator"),
    "auth": ("credentials", "operator"),
    "model_missing": ("proxy-config", "operator"),
    "not_found": ("proxy-config", "operator"),
    "rate_limit": ("provider-quota", "operator"),
    "timeout": ("proxy-host", "operator"),
    "transport": ("proxy-host", "operator"),
    "upstream": ("provider-or-proxy", "operator"),
    "protocol": ("endpoint-behavior", "agent"),
    "assertion": ("endpoint-behavior", "agent"),
    "request_rejected": ("endpoint-behavior", "agent"),
    "harness": ("harness", "agent"),
    "budget": ("run-budget", "agent"),
}
SEVERITY_RANK = {"critical": 0, "major": 1, "minor": 2, "info": 3}
TIER_PROFILE = {"light": "light", "full": "nightly", "manual": "manual"}
PACKAGE = "cliproxy"


def _command(run_profile, model, check, seed, config):
    if check is None:
        return "bun run cliproxy model-health --profile readiness"
    tier = next((c.tier for c in config.cases if c.capability == check), "full")
    profile = TIER_PROFILE[tier]
    return "bun run cliproxy %s --profile %s --model %s --check %s --seed %s" % (
        "model-health" if profile == "light" else "model-suite", profile, model, check, seed)


def _hints(category, model, check, config):
    base = PACKAGE + "/models.json"
    if category in ("protocol", "assertion", "request_rejected"):
        capability = "capabilities['%s']" % check if check else "capabilities"
        return [
            "Run the reproduce command and read the evidence trace; decide whether the endpoint or the expectation is wrong.",
            "Endpoint violates the public protocol: fix the proxy or provider configuration (an operator change); this repo cannot.",
            "The provider route genuinely lacks the capability: in %s set models[id=%s].%s to optional or "
            "{\"state\": \"unsupported\", \"reason\": \"...\"}. Never delete the check." % (base, model, capability),
            "The expectation is wrong: edit checks[id=%s] in %s, or the validators in %s/scripts/modelhealth/protocol.py and expect.py, "
            "and add a regression test in %s/tests/test_model_protocol.py." % ((check or "").split(".", 1)[-1], base, PACKAGE, PACKAGE),
        ]
    if category == "harness":
        return ["A defect in the checks, not the endpoint: run `bun run --filter @pkgs/cliproxy-fleet test:models`, "
                "read the traceback class in the details, and fix %s/scripts/modelhealth/checks.py or the check fixture." % PACKAGE]
    if category == "budget":
        return ["The run ran out of its request or token budget. Raise runs.<profile>.budget in %s only if the cost is justified, "
                "or run fewer checks with --check." % base]
    advice = config.raw["diagnostics"].get(category)
    return [advice] if advice else []


def _evidence_line(trace):
    parts = ["%s %s" % (trace.get("method", ""), trace.get("path", ""))]
    if trace.get("http_status") is not None:
        parts.append("HTTP %s" % trace["http_status"])
    response = trace.get("response") or {}
    for key in ("finish_reason", "events"):
        if response.get(key) is not None:
            parts.append("%s=%s" % (key, response[key]))
    if response.get("tool_calls"):
        parts.append("tool_calls=" + ",".join(response["tool_calls"]))
    if trace.get("retry_after"):
        parts.append("retry-after=%s" % trace["retry_after"])
    for key in ("cf_ray", "request_id"):
        if trace.get(key):
            parts.append("%s=%s" % (key, trace[key]))
    return " ".join(parts)


def build(config, report, profile_name):
    seed = report["seed"]
    findings = []

    def add(finding_id, category, severity, status, summary, model=None, check=None, endpoint=None, details=None, trace=None,
            reproduce=None):
        owner, resolver = OWNERS.get(category, ("unknown", "operator"))
        findings.append({
            "id": finding_id, "status": status, "severity": severity, "category": category,
            "model": model, "check": check, "endpoint": endpoint, "summary": summary,
            "owner": owner, "resolver": resolver, "agent_fixable": resolver == "agent",
            "evidence": {"details": details or [], "trace": trace or []},
            "reproduce": reproduce or _command(profile_name, model, check, seed, config),
            "fix_hints": _hints(category, model, check, config),
        })

    for name, level in report["levels"].items():
        if level["status"] in ("unhealthy", "unknown") and level["category"] and level["category"] != "model_missing":
            add("level:%s/%s" % (name, level["category"]), level["category"], "critical", "fail",
                "The %s level is %s: %s" % (name, level["status"], "; ".join(level["details"]) or level["category"]),
                details=level["details"])
    for model in report["models"]:
        mid = model["id"]
        paused = next((r for r in model["reasons"] if r.startswith("paused:")), None)
        if paused:
            last = model.get("rate_limit_detail")
            add("%s/rate_limit" % mid, "rate_limit", "critical", "paused",
                "%s is rate limited; inference is paused (no quota is spent while it is)." % mid, model=mid,
                details=[paused] + (["last error seen: " + last] if last else []),
                reproduce="bun run cliproxy model-health --profile light --model %s --force-probe" % mid)
        if any(r.startswith("model not served") for r in model["reasons"]):
            add("%s/model_missing" % mid, "model_missing", "critical", "fail",
                "%s is not listed by /v1/models" % mid, model=mid, details=model["reasons"])
        for result in model["checks"]:
            if result["status"] == "fail":
                add("%s/%s/%s" % (mid, result["capability"], result["category"]), result["category"], result["severity"], "fail",
                    "%s failed %s (%s)" % (mid, result["capability"], result["title"]), model=mid, check=result["capability"],
                    endpoint=result["endpoint"], details=result.get("details"), trace=result.get("trace"))
            elif result["status"] == "untested" and result["category"] == "budget":
                add("%s/%s/budget" % (mid, result["capability"]), "budget", "info", "untested",
                    "%s was not run for %s: budget exhausted" % (result["capability"], mid), model=mid, check=result["capability"],
                    details=result["details"])
    for sim in report["simulations"]:
        if sim["status"] != "pass":
            add("simulation:%s" % sim["id"], "harness", "major", "fail", "Simulated scenario %s failed: %s" % (sim["id"], sim["title"]),
                details=sim["details"])
    findings.sort(key=lambda f: (f["resolver"] != "operator", SEVERITY_RANK[f["severity"]], f["id"]))
    return findings


def fingerprint(findings):
    text = "\n".join(sorted("%s|%s" % (f["id"], f["status"]) for f in findings))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def render_brief(report):
    findings = report["findings"]
    summary = report["summary"]
    out = ["# CLI proxy model health: %s (agent brief)" % summary["status"].upper(), ""]
    out.append("Profile `%s`, suite `%s`, target `%s`, seed `%s`, %s. Full detail: `model-health.json` (`findings[]`, `models[]`), human report: `model-health.md`." % (
        report["profile"], report["suite"], report["target"]["kind"], report["seed"], report["generated_at"]))
    out.append("")
    out.append("| Model | Status | Passing | Failing | Untested | Declared unsupported |")
    out.append("| --- | --- | --- | --- | --- | --- |")
    for m in report["models"]:
        by = m["coverage"]["by_result"]
        out.append("| %s | %s | %d | %d | %d | %d |" % (m["id"], m["status"], by.get("pass", 0), by.get("fail", 0),
                                                       by.get("untested", 0), by.get("unsupported", 0) + by.get("observed_unsupported", 0)))
    out.append("")
    if not findings:
        out.append("No findings. Status `%s` describes only what was exercised (`untested` capabilities are not claims of health)." % summary["status"])
        out.append("")
        return "\n".join(out)
    operator = [f for f in findings if not f["agent_fixable"]]
    agent = [f for f in findings if f["agent_fixable"]]
    out.append("%d finding(s): %d need an operator, %d an agent can attempt. Findings are ordered by who can fix them, then severity." % (
        len(findings), len(operator), len(agent)))
    out.append("")
    for title, group in (("Needs an operator (cannot be fixed by editing this repository)", operator),
                         ("An agent can attempt these", agent)):
        if not group:
            continue
        out.append("## " + title)
        out.append("")
        for f in group:
            out.append("### `%s` (%s, %s, %s)" % (f["id"], f["severity"], f["category"], f["status"]))
            out.append("- **What:** " + f["summary"])
            out.append("- **Owner:** %s" % f["owner"] + ("; endpoint `%s`" % f["endpoint"] if f["endpoint"] else ""))
            for detail in f["evidence"]["details"][:4]:
                out.append("- **Detail:** " + detail)
            for trace in f["evidence"]["trace"][:3]:
                out.append("- **Trace:** " + _evidence_line(trace) + (" error: %s" % trace["error"] if trace.get("error") else ""))
                for violation in (trace.get("response") or {}).get("violations", [])[:4]:
                    out.append("  - violation: " + violation)
            out.append("- **Reproduce (cheap, one check):** `%s`" % f["reproduce"])
            for hint in f["fix_hints"]:
                out.append("- **Fix:** " + hint)
            out.append("")
    out.append("## Verify a fix")
    out.append("")
    out.append("1. Offline contracts, no spend: `bun run --filter @pkgs/cliproxy-fleet test:models` and `bun run cliproxy model-suite --target mock --profile manual`.")
    out.append("2. Live, cheapest first: the finding's reproduce command, then `bun run cliproxy model-health --profile readiness`, then `model-health` (light).")
    out.append("3. Do not claim health from an offline result; a fix is verified only by a `live` target run whose finding is gone.")
    out.append("")
    return "\n".join(out)
