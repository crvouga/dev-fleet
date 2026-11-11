"""Run declarative routing, rate-limit and fault scenarios against the local emulator.

Evidence from these scenarios is labelled ``simulated``. It proves the harness
detects and classifies the behavior; it never proves the production proxy's
accounts, quotas or failover are healthy.
"""

import random
import time

from . import checks, protocol
from .emulator import Account, Emulator
from .redact import Redactor
from .transport import Client

DEFAULT_TURN = {"messages": [{"role": "user", "content": "Reply with the single word OK."}], "max_tokens": 64}


def _expect(step_expect, outcomes, emulator, sent, elapsed):
    """Return a list of mismatches for one step's expectations."""
    problems = []
    last = outcomes[-1]
    wanted = step_expect
    if "status" in wanted and any(o.status != wanted["status"] for o in outcomes):
        problems.append("HTTP status %s, expected %s" % ([o.status for o in outcomes], wanted["status"]))
    if "category" in wanted and any(o.category != wanted["category"] for o in outcomes):
        problems.append("category %s, expected %s" % ([o.category for o in outcomes], wanted["category"]))
    served = [o.headers.get("x-emulator-account") for o in outcomes]
    if "served_by_all" in wanted and any(s not in wanted["served_by_all"] for s in served):
        problems.append("served by %s, expected only %s" % (served, wanted["served_by_all"]))
    if "served_sequence" in wanted and served != wanted["served_sequence"]:
        problems.append("served by %s, expected the sequence %s" % (served, wanted["served_sequence"]))
    if "served_set" in wanted and set(served) != set(wanted["served_set"]):
        problems.append("served by %s, expected exactly %s" % (sorted(set(served)), wanted["served_set"]))
    if wanted.get("single_account") and len(set(served)) != 1:
        problems.append("session was not pinned to one account: %s" % sorted(set(served)))
    if wanted.get("retry_after") and not last.retry_after:
        problems.append("Retry-After header was not surfaced")
    if wanted.get("envelope") and "no error envelope" in (last.detail or ""):
        problems.append("error response lacks an OpenAI error envelope")
    if wanted.get("no_retry") and emulator.requests != sent:
        problems.append("harness sent %d requests where %d were issued (hidden retry)" % (emulator.requests, sent))
    if "max_elapsed_s" in wanted and elapsed > wanted["max_elapsed_s"]:
        problems.append("took %.1fs, limit %.1fs" % (elapsed, wanted["max_elapsed_s"]))
    if wanted.get("single_model") and len({o.norm.model for o in outcomes if o.norm}) != 1:
        problems.append("response model id differed across accounts")
    if "violation" in wanted:
        if not any(wanted["violation"] in v for o in outcomes if o.norm for v in o.norm.violations):
            problems.append("expected protocol violation %r was not detected" % wanted["violation"])
    elif wanted.get("status") == 200:
        for o in outcomes:
            if o.norm is None or o.norm.violations:
                problems.append("successful response was not contract-valid")
                break
    return problems


def run_scenario(config, scenario, seed=0):
    model_ids = [m["id"] for m in config.models]
    accounts = []
    for spec in scenario["accounts"]:
        account = Account(spec["id"], quota=spec.get("quota"))
        account.fail_next = spec.get("fail_next", 0)
        accounts.append(account)
    emulator = Emulator(model_ids, accounts=accounts, strategy=scenario.get("strategy", config.raw["routing"]["strategy"]))
    base = emulator.start()
    redact = Redactor([emulator.key])
    timeouts = dict(config.raw["timeouts"], **scenario.get("timeouts", {}))
    budget = checks.Budget(10_000, 10_000, 10_000_000)
    ctx = checks.Context(config, config.models[0],
                         lambda model_id: Client(base, emulator.key, redact, timeouts["request_s"],
                                              lambda kind: budget.take(model_id) if kind in ("inference", "probe") else None),
                         budget, random.Random(seed), redact, timeouts)
    details, sent = [], 0
    try:
        for number, step in enumerate(scenario["steps"], 1):
            action = step.get("action")
            if action == "advance":
                emulator.advance(step["seconds"])
            elif action == "account":
                account = emulator.account(step["id"])
                account.quota = step.get("quota", account.quota)
                account.fail_next = step.get("fail_next", account.fail_next)
            elif action == "fault":
                emulator.fault(**step["faults"])
            elif action == "clear_faults":
                emulator.clear_faults()
            else:
                request = step["request"]
                turn = dict(request.get("turn") or DEFAULT_TURN)
                outcomes, started = [], time.monotonic()
                for index in range(step.get("count", 1)):
                    # Distinct sessions are new clients (cold bindings); "same" is one session (affinity).
                    session = "same" if request.get("session") == "same" else "s%d-%d" % (number, index)
                    outcomes.append(checks.call(ctx, request["protocol"], turn, {},
                                                headers={"X-Session-Id": session if session != "same" else "pinned"}))
                    sent += 1
                problems = _expect(step["expect"], outcomes, emulator, sent, time.monotonic() - started)
                details += ["step %d: %s" % (number, p) for p in problems]
    except Exception as error:  # a scenario defect must be visible, not swallowed
        details.append("harness error: %s" % type(error).__name__)
    finally:
        log = list(emulator.routing_log)
        emulator.stop()
    return {"id": scenario["id"], "capability": scenario["capability"], "title": scenario["title"],
            "status": "fail" if details else "pass", "evidence": "simulated", "details": details,
            "routing": [{"tried": entry["tried"], "served_by": entry["served_by"]} for entry in log]}


def run_all(config, seed=0):
    return [run_scenario(config, scenario, seed) for scenario in config.raw.get("simulations", [])]
