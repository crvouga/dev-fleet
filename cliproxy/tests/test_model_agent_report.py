"""The report must give an agent enough to fix a failure, cheaply and without leaking prompts or keys."""

import json
import pathlib
import tempfile
import unittest

import modelhealth_support as support
from modelhealth import cli, findings, schema

OPUS, SONNET, ASTRA, SOL = support.MODEL_IDS
SCHEMA = json.loads((support.PACKAGE / "docs/model-health-report.schema.json").read_text())


def failing_report(**faults):
    with support.served() as (emulator, base):
        emulator.fault(**faults)
        return support.run(emulator, base, "nightly", seed=9)


class Findings(unittest.TestCase):
    def test_healthy_report_has_no_findings_and_validates_against_the_published_schema(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", simulations=True)
        self.assertEqual(report["findings"], [])
        self.assertEqual(schema.errors(report, SCHEMA), [])
        self.assertEqual(report["summary"]["findings"]["total"], 0)

    def test_protocol_failure_names_who_fixes_it_how_to_reproduce_it_and_where_to_edit(self):
        report = failing_report(drop_tool_ids=True)
        self.assertEqual(schema.errors(report, SCHEMA), [])
        finding = next(f for f in report["findings"] if f["id"] == "%s/chat.tools/protocol" % OPUS)
        self.assertTrue(finding["agent_fixable"])
        self.assertEqual((finding["owner"], finding["severity"], finding["endpoint"]), ("endpoint-behavior", "critical", "/chat/completions"))
        self.assertEqual(finding["reproduce"],
                         "bun run cliproxy model-suite --profile nightly --model %s --check chat.tools --seed 9" % OPUS)
        text = " ".join(finding["fix_hints"])
        self.assertIn("cliproxy/models.json", text)
        self.assertIn("never delete the check", text.lower())
        trace = finding["evidence"]["trace"][0]
        self.assertEqual((trace["path"], trace["http_status"], trace["request"]["tool_choice"]), ("/chat/completions", 200, "forced:get_weather"))
        self.assertTrue(trace["response"]["violations"])

    def test_provider_quota_is_an_operator_finding_an_agent_must_not_try_to_fix(self):
        report = failing_report(model_status={SOL: 429}, retry_after=7)
        finding = next(f for f in report["findings"] if f["id"].startswith(SOL) and f["category"] == "rate_limit")
        self.assertFalse(finding["agent_fixable"])
        self.assertEqual((finding["owner"], finding["resolver"]), ("provider-quota", "operator"))
        self.assertEqual(finding["evidence"]["trace"][0]["retry_after"], "7")
        self.assertEqual(report["findings"][0]["resolver"], "operator")  # operator items are listed first

    def test_reproduce_command_runs_exactly_one_cheap_check(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", model_ids=[OPUS], only=["chat.tools"])
            posts = emulator.requests
        self.assertEqual(posts, 1)
        self.assertEqual([c["capability"] for c in report["models"][0]["checks"]], ["chat.tools"])

    def test_traces_and_briefs_never_contain_prompt_text_or_keys(self):
        report = failing_report(bad_usage=True, drop_tool_ids=True, model_status={SONNET: 503})
        blob = json.dumps(report["findings"]) + findings.render_brief(report)
        for forbidden in ("single word OK", "code word", "Count from", "emulator-client-key", "Berlin", "Paris"):
            self.assertNotIn(forbidden, blob)

    def test_brief_orders_operator_items_first_and_ends_with_how_to_verify(self):
        brief = findings.render_brief(failing_report(model_status={SONNET: 503}, drop_tool_ids=True))
        self.assertLess(brief.index("Needs an operator"), brief.index("An agent can attempt"))
        self.assertIn("Reproduce (cheap, one check)", brief)
        self.assertIn("Do not claim health from an offline result", brief)

    def test_fingerprint_changes_only_when_the_set_of_findings_changes(self):
        a, b = failing_report(drop_tool_ids=True), failing_report(drop_tool_ids=True)
        c = failing_report(bad_usage=True)
        self.assertEqual(a["summary"]["findings"]["fingerprint"], b["summary"]["findings"]["fingerprint"])
        self.assertNotEqual(a["summary"]["findings"]["fingerprint"], c["summary"]["findings"]["fingerprint"])

    def test_agent_brief_file_is_written_next_to_the_reports(self):
        import contextlib
        import io

        from modelhealth import cli

        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            code = cli.main(["--target", "mock", "--profile", "readiness", "--output", directory, "--json"])
            files = sorted(p.name for p in pathlib.Path(directory).iterdir())
        self.assertEqual((code, files), (0, ["agent-brief.md", "model-health.json", "model-health.md"]))


class RateLimitBackoff(unittest.TestCase):
    def test_rate_limited_model_is_not_probed_again_until_the_backoff_expires(self):
        with tempfile.TemporaryDirectory() as directory, support.served() as (emulator, base):
            state = str(pathlib.Path(directory) / "state.json")
            emulator.fault(model_status={SOL: 429})
            first = support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:00:00+00:00")
            emulator.requests = 0
            emulator.clear_faults()
            second = support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:10:00+00:00")
            sol = support.model(second, SOL)
            self.assertEqual((support.model(first, SOL)["rate_limited"], sol["paused"], sol["status"]), (True, True, "unhealthy"))
            self.assertEqual(emulator.requests, 6)  # three healthy models, two requests each; none to the paused one
            self.assertEqual(sol["checks"], [])
            self.assertTrue(sol["reasons"][0].startswith("paused:"))
            finding = next(f for f in second["findings"] if f["model"] == SOL)
            self.assertEqual((finding["status"], finding["agent_fixable"]), ("paused", False))
            self.assertTrue(any("last error seen" in d and "Injected fault" in d for d in finding["evidence"]["details"]))
            self.assertTrue(finding["reproduce"].endswith("--model %s --force-probe" % SOL))
            emulator.requests = 0
            third = support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:31:00+00:00")
            self.assertEqual((support.model(third, SOL)["status"], support.model(third, SOL)["paused"]), ("healthy", False))
            self.assertEqual(emulator.requests, 8)
            fourth_state = json.loads(pathlib.Path(state).read_text())
            self.assertIsNone(fourth_state["models"][SOL]["rate_limited_at"])  # cleared once a probe succeeds

    def test_quota_exhaustion_is_reported_but_never_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as directory, support.served() as (emulator, base):
            state = str(pathlib.Path(directory) / "state.json")
            emulator.fault(model_status={SOL: 429})
            first = support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:00:00+00:00")
            paused = support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:10:00+00:00")
        for report in (first, paused):
            self.assertEqual(support.model(report, SOL)["status"], "unhealthy")  # the model itself is still reported honestly
            self.assertEqual((report["summary"]["status"], report["summary"]["rate_limited"]), ("healthy", [SOL]))
            self.assertEqual(report["summary"]["findings"]["operator"], 1)
            self.assertEqual(cli.exit_code(report["summary"]["status"], "degraded", False), 0)

    def test_a_real_failure_still_fails_next_to_a_rate_limited_model(self):
        with support.served() as (emulator, base):
            emulator.fault(model_status={SOL: 429, SONNET: 503})
            report = support.run(emulator, base, "light")
        self.assertEqual((report["summary"]["status"], report["summary"]["rate_limited"]), ("unhealthy", [SOL]))

    def test_force_probe_overrides_the_pause(self):
        with tempfile.TemporaryDirectory() as directory, support.served() as (emulator, base):
            state = str(pathlib.Path(directory) / "state.json")
            emulator.fault(model_status={SOL: 429})
            support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:00:00+00:00")
            emulator.clear_faults()
            report = support.run(emulator, base, "light", state_path=state, force_probe=True, clock=lambda: "2026-01-01T00:05:00+00:00")
        self.assertEqual(support.model(report, SOL)["status"], "healthy")

    def test_pause_does_not_hide_other_models_and_survives_unrelated_runs(self):
        with tempfile.TemporaryDirectory() as directory, support.served() as (emulator, base):
            state = str(pathlib.Path(directory) / "state.json")
            emulator.fault(model_status={SOL: 429})
            support.run(emulator, base, "light", state_path=state, clock=lambda: "2026-01-01T00:00:00+00:00")
            support.run(emulator, base, "readiness", state_path=state, clock=lambda: "2026-01-01T00:05:00+00:00")
            data = json.loads(pathlib.Path(state).read_text())
        self.assertEqual(data["models"][SOL]["rate_limited_at"], "2026-01-01T00:00:00+00:00")


class UsageBounds(unittest.TestCase):
    def test_declared_budgets_cap_what_each_profile_can_spend(self):
        runs = support.RAW["runs"]
        self.assertLessEqual(runs["light"]["budget"]["max_requests"], 16)
        self.assertLessEqual(runs["light"]["budget"]["max_requests_per_model"], 3)
        self.assertLessEqual(runs["light"]["budget"]["max_output_tokens"], 2000)
        self.assertLess(runs["nightly"]["budget"]["max_output_tokens"], runs["manual"]["budget"]["max_output_tokens"])
        self.assertEqual(support.RAW["retry"]["inference"], 0)

    def test_every_check_declares_a_small_output_cap(self):
        for check in support.RAW["checks"]:
            for turn in (check.get("turn"), check.get("followup"), check.get("recover"), check.get("final")):
                if turn and "max_tokens" in turn:
                    self.assertLessEqual(turn["max_tokens"], 400, check["id"])
        agent = next(c for c in support.RAW["checks"] if c["id"] == "agent_workflow")
        self.assertLessEqual(agent["max_tokens"], 400)

    def test_light_profile_costs_two_requests_per_model(self):
        with support.served() as (emulator, base):
            support.run(emulator, base, "light")
            self.assertEqual(emulator.requests, 2 * len(support.MODEL_IDS))


if __name__ == "__main__":
    unittest.main()
