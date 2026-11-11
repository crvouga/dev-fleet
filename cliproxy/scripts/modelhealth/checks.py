"""Generic check engines. Model- and provider-specific behavior lives only in models.json."""

import concurrent.futures
import copy
import time

from . import expect as expectations
from . import protocol, scenario
from .transport import Client, TransportError

INFRA_CATEGORIES = ("auth", "rate_limit", "timeout", "transport", "upstream", "not_found")


class BudgetExceeded(Exception):
    pass


class Budget:
    """Thread-safe request and output-token ceilings for one run."""

    def __init__(self, max_requests, per_model, max_output_tokens):
        import threading

        self.max_requests, self.per_model, self.max_tokens = max_requests, per_model, max_output_tokens
        self.used, self.tokens, self.by_model = 0, 0, {}
        self.lock = threading.Lock()

    def take(self, model_id):
        with self.lock:
            if self.used >= self.max_requests:
                raise BudgetExceeded("run request budget exhausted")
            if self.by_model.get(model_id, 0) >= self.per_model:
                raise BudgetExceeded("per-model request budget exhausted")
            if self.tokens >= self.max_tokens:
                raise BudgetExceeded("output token budget exhausted")
            self.used += 1
            self.by_model[model_id] = self.by_model.get(model_id, 0) + 1

    def spend(self, tokens):
        with self.lock:
            self.tokens += tokens or 0


class Outcome:
    def __init__(self):
        self.norm = None
        self.category = None
        self.detail = None
        self.status = 0
        self.elapsed = 0.0
        self.ttft = None
        self.max_gap = None
        self.retry_after = None
        self.event = None
        self.stream_result = None
        self.headers = {}

    @property
    def failed(self):
        return self.category is not None


def http_category(status):
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "not_found"
    if status == 429:
        return "rate_limit"
    if status in (408, 504):
        return "timeout"
    if status >= 500:
        return "upstream"
    if status in (400, 413, 422):
        return "request_rejected"
    return "protocol"


class Context:
    """Everything a check needs for one model; no cross-model mutable state."""

    def __init__(self, config, model, client_factory, budget, rng, redact, timeouts):
        self.config, self.model, self.model_id = config, model, model["id"]
        self.make_client, self.budget, self.rng, self.redact = client_factory, budget, rng, redact
        self.timeouts = timeouts
        self.client = client_factory(self.model_id)
        self.events = []
        self.traces = []  # per-request evidence for failure reports; never contains prompt text
        self.observed_models = set()

    def token(self):
        letters = "".join(self.rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3))
        return "%s-%04d" % (letters, self.rng.randrange(10000))

    def variables(self):
        return {"model_id": self.model_id, "nonce": self.token(), "codeword": self.token(), "marker": self.token()}


def _envelope_detail(response, ctx):
    body = response.json()
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        error = body["error"]
        return ctx.redact("%s %s: %s" % (error.get("type", ""), error.get("code", ""), error.get("message", "")), 160)
    return "no error envelope"


def call(ctx, case_protocol, turn, variables, stop_after=None, model_id=None, headers=None):
    """Send one request and return an Outcome (never raises for HTTP/protocol failures)."""
    out = Outcome()
    config = ctx.config.raw
    body = scenario.build(case_protocol, model_id or ctx.model_id, turn, config, ctx.config.extra(ctx.model, case_protocol))
    path = config["protocols"][case_protocol]["path"]
    stream = bool(turn.get("stream"))
    event = {"protocol": case_protocol, "stream": stream, "tool": bool(turn.get("tools")), "ok": False,
             "category": None, "completed": False, "cancelled": False, "status": 0, "ttft": None, "total": None}
    out.event = event
    ctx.events.append(event)
    try:
        if stream:
            result = ctx.client.stream(path, body, timeout=ctx.timeouts["stream_idle_s"],
                                       deadline=ctx.timeouts["stream_deadline_s"], stop_after=stop_after,
                                       headers=headers)
            out.stream_result = result
            out.headers = result.headers
            out.status, out.elapsed, out.ttft = result.status, result.elapsed, result.ttft
            times = [f.at for f in result.frames]
            out.max_gap = max([b - a for a, b in zip(times, times[1:])] or [0.0])
            if result.status != 200:
                out.category = http_category(result.status)
                out.detail = "HTTP %d" % result.status
                return out
            if result.cancelled:
                event["cancelled"] = True
                return out
            out.norm = (protocol.chat_stream if case_protocol == "chat" else protocol.responses_stream)(result)
            event["completed"] = out.norm.terminated and not out.norm.violations and out.norm.upstream_error is None
        else:
            response = ctx.client.request("POST", path, body, timeout=ctx.timeouts["request_s"], kind="inference",
                                          headers=headers)
            out.status, out.elapsed = response.status, response.elapsed
            out.retry_after = response.headers.get("retry-after")
            out.headers = response.headers
            if response.status != 200:
                out.category = http_category(response.status)
                out.detail = "HTTP %d %s" % (response.status, _envelope_detail(response, ctx))
                return out
            payload = response.json()
            if payload is None:
                out.category, out.detail = "protocol", "response body is not JSON"
                return out
            out.norm = (protocol.chat_response if case_protocol == "chat" else protocol.responses_response)(payload)
    except TransportError as error:
        out.category, out.detail = error.category, error.detail
    except BudgetExceeded:
        ctx.events.remove(event)  # nothing was sent, so it is not a sample
        raise
    finally:
        ctx.traces.append(_trace(ctx, case_protocol, path, turn, out, stream))
        event.update(status=out.status, ttft=out.ttft, total=out.elapsed, category=out.category)
        if out.norm is not None:
            if out.norm.model:
                ctx.observed_models.add(out.norm.model)
            if out.norm.usage:
                ctx.budget.spend(out.norm.usage["output"])
    return out


def _choice_kind(choice):
    if isinstance(choice, dict):
        return "forced:" + str(choice.get("name"))
    return choice


def _trace(ctx, case_protocol, path, turn, out, stream):
    """Structural evidence about one request/response: shapes and numbers, never message text."""
    norm = out.norm
    headers = out.headers or {}
    trace = {
        "protocol": case_protocol, "method": "POST", "path": path, "stream": stream,
        "request": {"tools": list(turn.get("tools", [])), "tool_choice": _choice_kind(turn.get("tool_choice")),
                    "max_tokens": turn.get("max_tokens"), "json_schema": bool(turn.get("json_schema")),
                    "messages": len(turn.get("messages", []))},
        "http_status": out.status or None, "category": out.category,
        "total_ms": round(out.elapsed * 1000), "ttft_ms": round(out.ttft * 1000) if out.ttft is not None else None,
        "retry_after": out.retry_after,
        "cf_ray": headers.get("cf-ray"), "request_id": headers.get("x-request-id"),
    }
    if out.failed and out.detail:
        trace["error"] = ctx.redact(out.detail, 240)
    if norm is not None:
        trace["response"] = {
            "model": norm.model, "finish_reason": norm.finish_reason, "events": norm.events or None,
            "content_chars": len(norm.content), "tool_calls": [c["name"] for c in norm.tool_calls],
            "usage": norm.usage, "terminated": norm.terminated,
            "violations": [ctx.redact(v, 160) for v in norm.violations[:6]],
        }
    return trace


def judge(ctx, out, expect, variables, tool_names=()):
    """Return (category, [messages]) or (None, [])."""
    if out.failed:
        return out.category, [out.detail]
    schemas = scenario.tool_schemas(ctx.config.raw, tool_names)
    issues = expectations.evaluate(scenario.substitute(expect, variables), out.norm, schemas, out.max_gap)
    out.event["ok"] = not issues
    if issues:
        out.event["category"] = issues[0][0]
        return issues[0][0], [ctx.redact(message) for _category, message in issues[:6]]
    return None, []


class Verdict:
    def __init__(self, category=None, details=None, **observations):
        self.category, self.details, self.observations = category, details or [], observations

    @property
    def passed(self):
        return self.category is None


def _observe(out):
    seen = {}
    if out.norm is not None:
        seen["resolved_model"] = out.norm.model
        if out.norm.usage:
            seen["usage"] = out.norm.usage
        seen["finish_reason"] = out.norm.finish_reason
        seen["tool_calls"] = len(out.norm.tool_calls)
        if out.norm.stream:
            seen["stream_events"] = out.norm.events
    return seen


def _turn(case, ctx, variables):
    return scenario.substitute(copy.deepcopy(case.check["turn"]), variables)


def run_request(ctx, case, variables):
    turn = _turn(case, ctx, variables)
    out = call(ctx, case.protocol, turn, variables)
    category, details = judge(ctx, out, case.check["expect"], variables, turn.get("tools", []))
    return Verdict(category, details, _out=out, **_observe(out))


def _tool_turn(turn, norm, results, variables):
    calls = [{"id": c["id"], "name": c["name"], "arguments": c["arguments"] or "{}"} for c in norm.tool_calls]
    messages = list(turn["messages"]) + [{"role": "assistant", "content": norm.content or None, "tool_calls": calls}]
    for call_ in norm.tool_calls:
        messages.append({"role": "tool", "tool_call_id": call_["id"], "content": results[call_["name"]]})
    return messages


def run_roundtrip(ctx, case, variables):
    turn = _turn(case, ctx, variables)
    first = call(ctx, case.protocol, turn, variables)
    category, details = judge(ctx, first, case.check["expect"], variables, turn.get("tools", []))
    if category:
        return Verdict(category, ["step 1: " + d for d in details], **_observe(first))
    results = scenario.substitute(case.check["results"], variables)
    follow = scenario.substitute(case.check["followup"], variables)
    second_turn = dict(turn, messages=_tool_turn(turn, first.norm, results, variables),
                       tool_choice=follow.get("tool_choice"), max_tokens=follow.get("max_tokens", turn.get("max_tokens")))
    second_turn.pop("parallel_tool_calls", None)
    second = call(ctx, case.protocol, second_turn, variables)
    second.event["tool"] = False
    category, details = judge(ctx, second, follow["expect"], variables)
    observed = _observe(second)
    observed["tool_calls_first_turn"] = len(first.norm.tool_calls)
    return Verdict(category, ["step 2: " + d for d in details], **observed)


def _handle(handler, args, files):
    path = args.get("path", "")
    if handler["op"] == "read":
        return files.get(path, "error: no such file")
    if handler["op"] == "write":
        files[path] = args.get("content", "")
        return "ok: wrote %d bytes" % len(files[path])
    if handler["op"] == "run":
        return handler["pass"] if handler["needle"] in files.get(handler["path"], "") else handler["fail"]
    return "error: unsupported handler"


def run_agent(ctx, case, variables):
    check = scenario.substitute(copy.deepcopy(case.check), variables)
    files = dict(check["files"])
    messages = [{"role": "user", "content": check["task"]}]
    names = []
    for index, step in enumerate(check["steps"]):
        turn = {"system": check["system"], "messages": list(messages), "tools": check["tools"],
                "tool_choice": {"name": step["force"]}, "max_tokens": check["max_tokens"]}
        out = call(ctx, case.protocol, turn, variables)
        expect = {"finish_reason": ["tool_calls", "stop"],
                  "tool_calls": {"min": 1, "max": 1, "names": [step["force"]], "unique_ids": True,
                                 "arguments_schema": "from_tools", "arguments": step.get("arguments", {})}}
        category, details = judge(ctx, out, expect, variables, check["tools"])
        if category:
            return Verdict(category, ["step %d (%s): %s" % (index + 1, step["force"], d) for d in details], tool_sequence=names)
        call_ = out.norm.tool_calls[0]
        names.append(call_["name"])
        result = _handle(check["handlers"][call_["name"]], call_["args"], files)
        messages += [
            {"role": "assistant", "content": out.norm.content or None,
             "tool_calls": [{"id": call_["id"], "name": call_["name"], "arguments": call_["arguments"] or "{}"}]},
            {"role": "tool", "tool_call_id": call_["id"], "content": result},
        ]
    final = check["final"]
    out = call(ctx, case.protocol, {"system": check["system"], "messages": messages, "tools": check["tools"],
                                    "tool_choice": final["tool_choice"], "max_tokens": final["max_tokens"]}, variables)
    out.event["tool"] = False
    category, details = judge(ctx, out, final["expect"], variables)
    return Verdict(category, ["final: " + d for d in details], tool_sequence=names, **_observe(out))


def run_cancel_recover(ctx, case, variables):
    turn = _turn(case, ctx, variables)
    wanted = case.check["cancel_after_frames"]
    out = call(ctx, case.protocol, turn, variables, stop_after=wanted)
    if out.failed:
        return Verdict(out.category, [out.detail])
    if not out.stream_result.cancelled:
        return Verdict("assertion", ["stream ended before %d events, so cancellation was not exercised" % wanted])
    cancelled_ms = round(out.elapsed * 1000)
    recover = scenario.substitute(case.check["recover"], variables)
    again = call(ctx, case.protocol, recover, variables)
    category, details = judge(ctx, again, case.check["expect"], variables)
    verdict = Verdict(category, ["recovery request: " + d for d in details], cancelled_after_ms=cancelled_ms,
                      recovery_ms=round(again.elapsed * 1000))
    return verdict


def run_concurrent(ctx, case, variables):
    count = case.check["parallel"]
    runs = [ctx.variables() for _ in range(count)]

    def one(variables_):
        turn = _turn(case, ctx, variables_)
        out = call(ctx, case.protocol, turn, variables_)
        return judge(ctx, out, case.check["expect"], variables_, turn.get("tools", []))

    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        results = list(pool.map(one, runs))
    failures = [(i, r) for i, r in enumerate(results) if r[0]]
    if failures:
        first = failures[0][1]
        return Verdict(first[0], ["request %d of %d: %s" % (failures[0][0] + 1, count, d) for d in first[1]],
                       parallel=count, failed=len(failures))
    return Verdict(None, [], parallel=count, failed=0)


def run_error_probe(ctx, case, variables):
    check = case.check
    client = ctx.client
    if "key" in check:
        client = Client(ctx.client.base_url, check["key"], ctx.redact, ctx.client.timeout, ctx.client.on_request)
    path = ctx.config.raw["protocols"][case.protocol]["path"]
    if "raw_body" in check:
        body = check["raw_body"].encode()
    elif "body" in check:
        body = check["body"]
    else:
        model_id = check.get("model", ctx.model_id)
        body = scenario.build(case.protocol, model_id, scenario.substitute(check["turn"], variables), ctx.config.raw, {})
    event = {"protocol": case.protocol, "stream": False, "tool": False, "ok": False, "category": None,
             "completed": False, "cancelled": False, "status": 0, "ttft": None, "total": None, "probe": True}
    ctx.events.append(event)
    response = client.request("POST", path, body, timeout=ctx.timeouts["request_s"], kind="probe")
    event.update(status=response.status, total=response.elapsed)
    ctx.traces.append({"protocol": case.protocol, "method": "POST", "path": path, "stream": False,
                       "request": {"probe": case.check["id"], "body": "raw" if "raw_body" in check else "json"},
                       "http_status": response.status, "total_ms": round(response.elapsed * 1000),
                       "cf_ray": response.headers.get("cf-ray"), "request_id": response.headers.get("x-request-id"),
                       "error": _envelope_detail(response, ctx)})
    wanted = check["expect"]["status"]
    if response.status not in wanted:
        category = "assertion" if response.status < 500 else "upstream"
        event["category"] = category
        return Verdict(category, ["HTTP %d, expected one of %s" % (response.status, wanted)], http_status=response.status)
    if check["expect"].get("error_envelope"):
        problems = protocol.error_violations(response.json())
        if problems:
            event["category"] = "protocol"
            return Verdict("protocol", problems, http_status=response.status)
    event["ok"] = True
    return Verdict(None, [], http_status=response.status)


RUNNERS = {
    "request": run_request,
    "roundtrip": run_roundtrip,
    "agent": run_agent,
    "cancel_recover": run_cancel_recover,
    "concurrent": run_concurrent,
    "error_probe": run_error_probe,
}


def execute(ctx, case):
    """Run one case and return a result dict; never raises."""
    started = time.monotonic()
    result = {
        "id": case.id, "capability": case.capability, "protocol": case.protocol, "severity": case.severity,
        "title": case.check["title"], "endpoint": ctx.config.raw["protocols"][case.protocol]["path"],
        "status": "pass", "category": None, "details": [], "evidence": "live",
    }
    marker, trace_marker = len(ctx.events), len(ctx.traces)
    try:
        verdict = RUNNERS[case.kind](ctx, case, ctx.variables())
        verdict.observations.pop("_out", None)
        result["observations"] = verdict.observations
        if not verdict.passed:
            result["status"], result["category"], result["details"] = "fail", verdict.category, verdict.details
    except BudgetExceeded as error:
        result.update(status="untested", category="budget", details=[str(error)])
    except TransportError as error:
        result.update(status="fail", category=error.category, details=[error.detail])
    except Exception as error:  # a harness defect must not hide other models' results
        result.update(status="fail", category="harness", details=[ctx.redact(type(error).__name__ + ": " + str(error))])
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    if result["status"] != "pass":
        result["trace"] = ctx.traces[trace_marker:]
    mine = ctx.events[marker:]
    result["requests"] = len(mine)
    streams = [e["ttft"] for e in mine if e["stream"] and e["ttft"] is not None]
    result["ttft_ms"] = round(streams[0] * 1000) if streams else None
    if result["status"] == "fail" and result["category"] in INFRA_CATEGORIES:
        result["infrastructure"] = True
    return result
