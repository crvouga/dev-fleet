"""Load and validate the declarative model-health configuration (models.json)."""

import copy
import fnmatch
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import fleet_config

DEFAULT_PATH = pathlib.Path(__file__).resolve().parents[2] / "models.json"
TIERS = {"light": 1, "full": 2, "manual": 3}
SEVERITIES = ("critical", "major", "minor")
KINDS = ("request", "roundtrip", "agent", "cancel_recover", "concurrent", "error_probe")
SUITES = ("core", "cursor")
STATES = ("required", "optional", "unsupported")
VARIABLES = ("model_id", "nonce", "codeword", "marker")
CATEGORIES = (
    "credentials", "auth", "not_found", "rate_limit", "timeout", "transport", "upstream",
    "protocol", "assertion", "request_rejected", "budget", "aborted", "model_missing", "harness",
)


class ConfigError(ValueError):
    def __init__(self, problems):
        super().__init__("Invalid model-health configuration:\n- " + "\n- ".join(problems))
        self.problems = problems


class Case:
    """One check applied to one protocol; combined with a model it becomes a test."""

    def __init__(self, check, protocol):
        self.check = check
        self.protocol = protocol
        self.id = protocol + "." + check["id"]
        self.capability = self.id
        tier = check["tier"]
        self.tier = tier[protocol] if isinstance(tier, dict) else tier
        self.severity = check["severity"]
        self.kind = check["kind"]
        self.spends_inference = check.get("spends_inference", True)


class Config:
    def __init__(self, raw):
        self.raw = raw
        self.models = raw["models"]
        self.cases = [Case(check, protocol) for check in raw["checks"] for protocol in check["protocols"]]
        self.capabilities = [case.capability for case in self.cases]

    def runs(self, name):
        return self.raw["runs"][name]

    def cases_for(self, suite, max_tier, only=None):
        rank = TIERS[max_tier]
        return [
            case for case in self.cases
            if TIERS[case.tier] <= rank and (suite == "all" or suite in case.check["suites"])
            and (not only or any(fnmatch.fnmatchcase(case.capability, pattern) for pattern in only))
        ]

    def state(self, model, capability):
        """Declared state: ('required'|'optional'|'unsupported', reason)."""
        profile = self.raw["capability_profiles"][model["profile"]]
        state, reason = profile.get("default", "required"), None
        for pattern in profile.get("optional", []):
            if fnmatch.fnmatchcase(capability, pattern):
                state = "optional"
        for pattern, why in profile.get("unsupported", {}).items():
            if fnmatch.fnmatchcase(capability, pattern):
                state, reason = "unsupported", why
        for pattern, value in model.get("capabilities", {}).items():
            if fnmatch.fnmatchcase(capability, pattern):
                if isinstance(value, dict):
                    state, reason = value["state"], value.get("reason")
                else:
                    state, reason = value, None
        return state, reason

    def extra(self, model, protocol):
        profile = self.raw["capability_profiles"][model["profile"]].get("extra", {})
        merged = copy.deepcopy(profile.get(protocol, {}))
        for key, value in model.get("extra", {}).get(protocol, {}).items():
            merged[key] = copy.deepcopy(value)
        return merged


def validate(raw):
    problems = []

    def need(condition, message):
        if not condition:
            problems.append(message)

    need(raw.get("schema") == 1, "schema must be 1")
    endpoint = raw.get("endpoint", {})
    # The proxy origin is the fleet's own: it is never written in this file.
    if isinstance(endpoint, dict) and "base_url" not in endpoint:
        endpoint["base_url"] = fleet_config.endpoint() + "/v1"
    need(str(endpoint.get("base_url", "")).startswith("https://"), "endpoint.base_url must be HTTPS")
    need(bool(endpoint.get("key_env")), "endpoint.key_env is required")
    for name, run in raw.get("runs", {}).items():
        need(bool(run.get("levels")), "run %s needs levels" % name)
        if "e2e" in run.get("levels", []):
            need(run.get("max_tier") in TIERS, "run %s needs max_tier" % name)
            budget = run.get("budget", {})
            for key in ("max_requests", "max_requests_per_model", "max_output_tokens", "concurrency"):
                need(isinstance(budget.get(key), int) and budget[key] > 0, "run %s budget.%s must be a positive integer" % (name, key))
    need(set(raw.get("runs", {})) >= {"liveness", "readiness", "light", "nightly", "manual"}, "runs must define liveness, readiness, light, nightly and manual")
    need(raw.get("retry", {}).get("inference", 1) == 0, "inference retries must be 0 (retries mask persistent failures and multiply cost)")
    for name in ("request_s", "stream_idle_s", "stream_deadline_s", "liveness_s"):
        need(raw.get("timeouts", {}).get(name, 0) > 0, "timeouts.%s must be positive" % name)
    protocols = raw.get("protocols", {})
    need(set(protocols) == {"chat", "responses"}, "protocols must be chat and responses")
    need(raw.get("health", {}).get("rate_limit_backoff_s", 0) > 0, "health.rate_limit_backoff_s must be positive")
    need(raw.get("routing", {}).get("strategy") in ("fill-first", "round-robin", "weighted-round-robin"), "routing.strategy is required")

    tools = raw.get("tools", {})
    for name, spec in tools.items():
        need(isinstance(spec.get("parameters"), dict) and spec.get("description"), "tool %s needs description and parameters" % name)

    seen, capabilities = set(), []
    for check in raw.get("checks", []):
        where = "check %s" % check.get("id")
        need(check.get("id") and check["id"] not in seen, where + ": id missing or duplicated")
        seen.add(check.get("id"))
        need(check.get("kind") in KINDS, where + ": unknown kind")
        need(check.get("severity") in SEVERITIES, where + ": invalid severity")
        need(set(check.get("protocols", [])) <= set(protocols) and check.get("protocols"), where + ": invalid protocols")
        tier = check.get("tier")
        tiers = tier.values() if isinstance(tier, dict) else [tier]
        need(all(t in TIERS for t in tiers), where + ": invalid tier")
        if isinstance(tier, dict):
            need(set(tier) == set(check.get("protocols", [])), where + ": tier map must cover exactly its protocols")
        need(check.get("suites") and set(check["suites"]) <= set(SUITES), where + ": invalid suites")
        turn_tools = list(check.get("turn", {}).get("tools", [])) + list(check.get("tools", []))
        need(all(t in tools for t in turn_tools), where + ": references an undefined tool")
        text = json.dumps(check)
        unknown = set(re.findall(r"\{([a-z_]+)\}", text)) - set(VARIABLES)
        need(not unknown, where + ": unknown placeholders " + ", ".join(sorted(unknown)))
        for protocol in check.get("protocols", []):
            capabilities.append(protocol + "." + str(check.get("id")))
    names = {c.get("id") for c in raw.get("models", [])}
    need(len(names) == len(raw.get("models", [])) and None not in names, "model ids must be unique")
    need(bool(raw.get("models")), "at least one model is required")
    profiles = raw.get("capability_profiles", {})
    patterns = []
    for name, profile in profiles.items():
        patterns += [(p, "profile %s" % name) for p in profile.get("optional", [])]
        patterns += [(p, "profile %s" % name) for p in profile.get("unsupported", {})]
        for reason in profile.get("unsupported", {}).values():
            need(bool(reason), "profile %s: unsupported capabilities need a reason" % name)
    for model in raw.get("models", []):
        where = "model %s" % model.get("id")
        need(bool(model.get("id")) and model.get("provider"), where + ": id and provider are required")
        need(model.get("profile") in profiles, where + ": unknown capability profile")
        for pattern, value in model.get("capabilities", {}).items():
            patterns.append((pattern, where))
            state = value.get("state") if isinstance(value, dict) else value
            need(state in STATES, where + ": invalid state for " + pattern)
            if state == "unsupported":
                need(isinstance(value, dict) and value.get("reason"), where + ": unsupported " + pattern + " needs a reason")
    for pattern, owner in patterns:
        need(any(fnmatch.fnmatchcase(c, pattern) for c in capabilities), "%s: pattern %r matches no capability" % (owner, pattern))
    sim_ids, covered = set(), set()
    for sim in raw.get("simulations", []):
        need(sim.get("id") and sim["id"] not in sim_ids, "simulation %s: id missing or duplicated" % sim.get("id"))
        sim_ids.add(sim.get("id"))
        need(sim.get("capability") in raw.get("simulated_capabilities", {}), "simulation %s: unknown capability" % sim.get("id"))
        need(bool(sim.get("accounts")) and bool(sim.get("steps")), "simulation %s: accounts and steps are required" % sim.get("id"))
        covered.add(sim.get("capability"))
    need(covered >= set(raw.get("simulated_capabilities", {})), "simulated capabilities lack a scenario: "
         + ", ".join(sorted(set(raw.get("simulated_capabilities", {})) - covered)))
    missing = [c for c in CATEGORIES if c not in raw.get("diagnostics", {})]
    need(not missing, "diagnostics lack guidance for: " + ", ".join(missing))
    if problems:
        raise ConfigError(problems)


def load(path=None):
    raw = json.loads(pathlib.Path(path or DEFAULT_PATH).read_text())
    validate(raw)
    return Config(raw)
