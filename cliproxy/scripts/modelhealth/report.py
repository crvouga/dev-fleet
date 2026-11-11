"""Human-readable rendering of the structured health report (Markdown, readable in a terminal)."""

ICON = {"healthy": "HEALTHY", "degraded": "DEGRADED", "unhealthy": "UNHEALTHY", "unknown": "UNKNOWN"}
RESULT_ORDER = ["fail", "observed_unsupported", "untested", "unsupported", "pass"]


def _ms(value):
    return "-" if value is None else "%dms" % value


def _pct(value):
    return "-" if value is None else "%d%%" % round(value * 100)


def _row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"


def render(report, config):
    out = []
    summary = report["summary"]
    out.append("# CLIProxyAPI model health: %s" % ICON[summary["status"]])
    out.append("")
    target = report["target"]
    out.append("Profile `%s`, suite `%s`, target `%s` (%s), seed %s, %s." % (
        report["profile"], report["suite"], target["kind"], target["base_url"], report["seed"], report["generated_at"]))
    if "budget" in report:
        b = report["budget"]
        out.append("Spend: %d of %d requests, %d of %d output tokens; concurrency %d; inference retries %d (never retried)." % (
            b["requests_used"], b["requests_max"], b["output_tokens_used"], b["output_tokens_max"], b["concurrency"],
            b["inference_retries"]))
    out.append("")
    out += _findings(report)
    out.append("## Levels")
    for name, level in report["levels"].items():
        detail = "; ".join(level["details"]) or ("category " + level["category"] if level["category"] else "")
        extra = ""
        if name == "readiness" and level.get("served_models") is not None:
            extra = " %d models served" % level["served_models"]
            if level.get("discovered_unconfigured"):
                extra += "; discovered but not configured: " + ", ".join(level["discovered_unconfigured"])
        out.append("- **%s**: %s%s%s" % (name, ICON[level["status"]], extra, (" (" + detail + ")") if detail else ""))
    out.append("")
    if report["profile"] == "liveness":
        out.append("Models are not evaluated at the liveness level: it needs no credentials and proves only reachability.")
        out.append("")
    elif report["models"]:
        out.append("## Models")
        out.append(_row(["Model", "Status", "Exercised", "Pass", "Fail", "Untested", "Unsupported", "TTFT p50", "Latency p95",
                         "Streams ok", "Tools ok", "Last healthy"]))
        out.append(_row(["---"] * 12))
        for m in report["models"]:
            by = m["coverage"]["by_result"]
            metrics = m["metrics"]
            out.append(_row([m["id"], ICON[m["status"]], "%d/%d" % (m["coverage"]["exercised"], m["coverage"]["capabilities"]),
                             by.get("pass", 0), by.get("fail", 0), by.get("untested", 0),
                             by.get("unsupported", 0) + by.get("observed_unsupported", 0),
                             _ms(metrics["ttft_ms"]["p50"]), _ms(metrics["latency_ms"]["p95"]),
                             _pct(metrics["streaming_completion_rate"]), _pct(metrics["tool_call_success_rate"]),
                             (m.get("last_success") or {}).get("healthy_at") or "never recorded"]))
        out.append("")
        out.append("`untested` and `unsupported` capabilities are never counted as healthy. A model that is `healthy` is healthy only for the exercised capabilities.")
        out.append("")
        for m in report["models"]:
            out += _model(m)
    if report["simulations"]:
        out.append("## Simulated scenarios (emulator, not live evidence)")
        out.append(_row(["Scenario", "Capability", "Result", "Detail"]))
        out.append(_row(["---"] * 4))
        for sim in report["simulations"]:
            out.append(_row([sim["id"], sim["capability"], sim["status"].upper(), "; ".join(sim["details"]) or sim["title"]]))
        out.append("")
        routing = report["routing"]["declared"]
        out.append("Declared routing policy: `%s`, session affinity %s (live strategy is not observable through the API; the host monitor compares the running config with the template)." % (
            routing["strategy"], "on" if routing["session_affinity"] else "off"))
        out.append("")
        out.append("Account failover, cooldown recovery and all-accounts-unavailable behavior cannot be induced against the hosted proxy without exhausting real subscription quota, so live routing stays `untested`.")
        out.append("")
    if report["profile"] != "liveness":
        out += _cursor(report, config)
    return "\n".join(out)


def _findings(report):
    findings = report["findings"]
    if not findings:
        return ["## Findings", "", "None. `untested` capabilities below are not claims of health.", ""]
    out = ["## Findings (%d: %d need an operator, %d an agent can attempt)" % (
        len(findings), report["summary"]["findings"]["operator"], report["summary"]["findings"]["agent"]), ""]
    out.append(_row(["Finding", "Who fixes", "Category", "What", "Reproduce"]))
    out.append(_row(["---"] * 5))
    for f in findings:
        out.append(_row(["`%s`" % f["id"], "agent" if f["agent_fixable"] else "operator", f["category"], f["summary"],
                         "`%s`" % f["reproduce"]]))
    out += ["", "Evidence traces and fix hints for each finding are in `model-health.json` (`findings[]`) and `agent-brief.md`.", ""]
    return out


def _model(m):
    out = ["### %s: %s (%s)" % (m["id"], ICON[m["status"]], m["provider"])]
    for reason in m["reasons"]:
        out.append("- " + reason)
    metrics = m["metrics"]
    if metrics["requests"]:
        out.append("- Requests %d, availability %s, check success %s, resolved model id: %s. Error categories: %s." % (
            metrics["requests"], _pct(metrics["availability"]), _pct(metrics["success_rate"]),
            ", ".join(metrics["resolved_models"]) or "-",
            ", ".join("%s=%d" % kv for kv in sorted(metrics["error_categories"].items())) or "none"))
    last = m.get("last_success") or {}
    out.append("- Last successful validation: healthy %s; any passing check %s." % (
        last.get("healthy_at") or "never recorded", last.get("any_check_at") or "never recorded"))
    rows = m["capabilities"]
    passed = sorted(c for c, r in rows.items() if r["result"] == "pass")
    if passed:
        out.append("- **Passed (%d):** %s" % (len(passed), ", ".join(passed)))
    detailed = sorted(((c, r) for c, r in rows.items() if r["result"] in ("fail", "observed_unsupported")),
                      key=lambda item: (RESULT_ORDER.index(item[1]["result"]), item[0]))
    grouped = {}
    for capability, row in sorted(rows.items()):
        if row["result"] in ("untested", "unsupported"):
            grouped.setdefault((row["result"], row["reason"] or ""), []).append(capability)
    for (result, reason), capabilities in sorted(grouped.items(), key=lambda item: (RESULT_ORDER.index(item[0][0]), item[0][1])):
        out.append("- **%s (%d)**, %s: %s" % (result.upper(), len(capabilities), reason or "no reason recorded", ", ".join(capabilities)))
    if detailed:
        out.append("")
        out.append(_row(["Capability", "Declared", "Result", "Why"]))
        out.append(_row(["---"] * 4))
        for capability, row in detailed:
            out.append(_row([capability, row["declared"], row["result"].upper().replace("_", " "), row["reason"] or ""]))
    out.append("")
    return out


def _cursor(report, config):
    cursor = report["cursor"]
    out = ["## Cursor-style agent compatibility (protocol level)", "", cursor["note"], "",
           "Verified with the actual Cursor application: **%s**." % ("yes" if cursor["application_verified"] else "no"), ""]
    ids = [case.capability for case in config.cases if "cursor" in case.check["suites"]]
    if report["models"]:
        out.append(_row(["Model", "Pass", "Fail", "Untested", "Unsupported"]))
        out.append(_row(["---"] * 5))
        for m in report["models"]:
            counts = {}
            for capability in ids:
                result = m["capabilities"][capability]["result"]
                counts[result] = counts.get(result, 0) + 1
            out.append(_row([m["id"], counts.get("pass", 0), counts.get("fail", 0), counts.get("untested", 0),
                             counts.get("unsupported", 0) + counts.get("observed_unsupported", 0)]))
        out.append("")
    return out
