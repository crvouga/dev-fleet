"""Health-level, isolation, budget, fault-detection and reporting behavior against the emulator."""

import contextlib
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

import modelhealth_support as support
from modelhealth import cli, report as reporting, runner, simulate

OPUS, SONNET, ASTRA, SOL = support.MODEL_IDS


class FullSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with support.served() as (emulator, base):
            cls.report = support.run(emulator, base, "manual", simulations=True)
            cls.posts = emulator.requests

    def test_every_model_id_is_validated_independently_and_passes_every_capability(self):
        self.assertEqual(self.report["summary"]["status"], "healthy")
        self.assertEqual([m["id"] for m in self.report["models"]], support.MODEL_IDS)
        for m in self.report["models"]:
            self.assertEqual(m["status"], "healthy", m["reasons"])
            self.assertEqual(set(m["coverage"]["by_result"]), {"pass"}, m["id"])
            self.assertEqual(m["metrics"]["resolved_models"], [m["id"]])
            self.assertEqual(m["metrics"]["streaming_completion_rate"], 1.0)
            self.assertEqual(m["metrics"]["tool_call_success_rate"], 1.0)

    def test_budget_is_respected_and_nothing_is_retried(self):
        budget = self.report["budget"]
        self.assertLessEqual(budget["requests_used"], budget["requests_max"])
        self.assertEqual(budget["inference_retries"], 0)
        self.assertEqual(self.posts, budget["requests_used"])  # one POST per budgeted request

    def test_simulations_are_labelled_and_pass(self):
        self.assertGreaterEqual(len(self.report["simulations"]), 10)
        self.assertTrue(all(s["status"] == "pass" and s["evidence"] == "simulated" for s in self.report["simulations"]))

    def test_report_never_contains_credentials_or_prompt_text(self):
        text = json.dumps(self.report) + reporting.render(self.report, support.load())
        self.assertNotIn("emulator-client-key", text)
        for fixture in ("single word OK", "code word", "Count from 1"):
            self.assertNotIn(fixture, text)

    def test_cursor_section_separates_protocol_compatibility_from_application_verification(self):
        self.assertFalse(self.report["cursor"]["application_verified"])
        text = reporting.render(self.report, support.load())
        self.assertIn("Verified with the actual Cursor application: **no**", text)


class Independence(unittest.TestCase):
    def test_one_failing_model_does_not_stop_the_others(self):
        with support.served() as (emulator, base):
            emulator.fault(model_status={OPUS: 503})
            report = support.run(emulator, base, "nightly")
        self.assertEqual(support.model(report, OPUS)["status"], "unhealthy")
        for model_id in (SONNET, ASTRA, SOL):
            self.assertEqual(support.model(report, model_id)["status"], "healthy")
        self.assertEqual(report["summary"]["status"], "unhealthy")
        opus = support.model(report, OPUS)
        self.assertEqual(opus["metrics"]["error_categories"], {"upstream": 4})  # aborted after four consecutive failures
        self.assertIn("aborted", " ".join(opus["reasons"]))
        finding = next(f for f in report["findings"] if f["model"] == OPUS and f["check"] == "chat.basic")
        self.assertEqual((finding["category"], finding["endpoint"].startswith("/")), ("upstream", True))
        self.assertTrue(finding["fix_hints"])
        self.assertLess(support.model(report, OPUS)["metrics"]["requests"], 8)

    def test_missing_model_id_is_reported_never_skipped(self):
        with support.served() as (emulator, base):
            emulator.fault(missing_models={ASTRA})
            report = support.run(emulator, base, "light")
        self.assertEqual(report["levels"]["readiness"]["category"], "model_missing")
        self.assertIn(ASTRA, report["levels"]["readiness"]["details"][0])
        astra = support.model(report, ASTRA)
        self.assertEqual(astra["status"], "unhealthy")
        self.assertEqual(astra["checks"], [])
        self.assertEqual(astra["capabilities"]["chat.basic"]["reason"], "model_missing")
        self.assertEqual(support.model(report, SOL)["status"], "healthy")
        self.assertEqual(report["summary"]["status"], "unhealthy")

    def test_unconfigured_discovered_models_are_listed(self):
        with support.served(support.MODEL_IDS + ["extra-model"]) as (emulator, base):
            report = support.run(emulator, base, "readiness")
        self.assertEqual(report["levels"]["readiness"]["discovered_unconfigured"], ["extra-model"])

    def test_inconsistent_model_id_resolution_degrades_the_model(self):
        # Two accounts that answer with different model ids would show up as several resolved ids.
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "light")
            model = support.model(report, OPUS)
            model["metrics"]["resolved_models"] = ["a", "b"]
            status, reasons = runner.derive_status(support.load(), model["capabilities"], model["checks"], model["metrics"], True, True, True)
        self.assertEqual(status, "degraded")
        self.assertIn("multiple ids", reasons[0])


class CapabilityHonesty(unittest.TestCase):
    def test_declared_unsupported_is_not_requested_and_not_called_broken(self):
        def no_tools(raw):
            raw["models"][0]["capabilities"] = {"*.tools*": {"state": "unsupported", "reason": "No function calling."},
                                                "*.tool_roundtrip": {"state": "unsupported", "reason": "No function calling."}}

        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", config=support.load(no_tools))
        opus = support.model(report, OPUS)
        self.assertEqual(opus["capabilities"]["chat.tools"]["result"], "unsupported")
        self.assertNotIn("chat.tools", [c["capability"] for c in opus["checks"]])
        self.assertEqual(opus["status"], "healthy")

    def test_optional_capability_that_fails_cleanly_is_observed_unsupported_not_failing(self):
        def impossible_json(raw):
            check = next(c for c in raw["checks"] if c["id"] == "json_schema")
            check["expect"]["json"]["schema"]["properties"]["city"]["const"] = "Never"

        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", config=support.load(impossible_json))
        row = support.model(report, SOL)["capabilities"]["chat.json_schema"]
        self.assertEqual((row["declared"], row["result"]), ("optional", "observed_unsupported"))
        self.assertEqual(support.model(report, SOL)["status"], "healthy")

    def test_the_same_failure_on_a_required_capability_is_a_failure(self):
        def required_json(raw):
            check = next(c for c in raw["checks"] if c["id"] == "json_schema")
            check["expect"]["json"]["schema"]["properties"]["city"]["const"] = "Never"
            raw["capability_profiles"]["frontier-agent"]["optional"].remove("*.json_schema")

        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", config=support.load(required_json))
        sol = support.model(report, SOL)
        self.assertEqual(sol["capabilities"]["chat.json_schema"]["result"], "fail")
        self.assertEqual(sol["status"], "degraded")  # minor severity: degraded, not unhealthy

    def test_untested_is_never_reported_as_passing(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "light")
        for m in report["models"]:
            self.assertEqual(m["capabilities"]["chat.basic"]["result"], "pass")
            self.assertEqual(m["capabilities"]["responses.stream"]["result"], "pass")
            self.assertEqual(m["capabilities"]["chat.tools"]["result"], "untested")
            self.assertEqual(m["capabilities"]["chat.tools"]["reason"], "not_in_profile")
            self.assertEqual(m["coverage"]["exercised"], 2)

    def test_budget_exhaustion_leaves_checks_untested(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "nightly", overrides={"max_requests": 6})
            posts = emulator.requests
        self.assertLessEqual(posts, 6)
        untested = [r for m in report["models"] for r in m["capabilities"].values() if r["reason"] == "budget"]
        self.assertTrue(untested)
        self.assertTrue(all(r["result"] == "untested" for r in untested))

    def test_rate_limit_stops_that_model_immediately(self):
        with support.served() as (emulator, base):
            emulator.fault(model_status={SONNET: 429}, retry_after=5)
            report = support.run(emulator, base, "nightly")
        sonnet = support.model(report, SONNET)
        self.assertEqual(sonnet["metrics"]["requests"], 1)
        self.assertEqual(sonnet["metrics"]["error_categories"], {"rate_limit": 1})
        self.assertIn("rate limited", " ".join(sonnet["reasons"]))


class FaultDetection(unittest.TestCase):
    def run_with(self, model_id=OPUS, profile="nightly", **faults):
        with support.served() as (emulator, base):
            emulator.fault(**faults)
            report = support.run(emulator, base, profile, model_ids=[model_id])
        return support.model(report, model_id)

    def failing(self, model):
        return {c["capability"]: c["category"] for c in model["checks"] if c["status"] == "fail"}

    def test_missing_tool_call_ids_are_a_protocol_failure(self):
        failing = self.failing(self.run_with(drop_tool_ids=True))
        self.assertEqual(failing["chat.tools"], "protocol")

    def test_invalid_tool_arguments_are_detected(self):
        self.assertEqual(self.failing(self.run_with(bad_json_args=True))["chat.tools"], "protocol")

    def test_usage_arithmetic_is_checked(self):
        self.assertEqual(self.failing(self.run_with(bad_usage=True))["chat.basic"], "protocol")

    def test_wrong_finish_reason_is_an_assertion_failure(self):
        self.assertEqual(self.failing(self.run_with(finish_reason="length"))["chat.basic"], "assertion")

    def test_missing_done_marker_fails_chat_streams_only(self):
        failing = self.failing(self.run_with(omit_done=True))
        self.assertEqual(failing["chat.stream"], "protocol")
        self.assertNotIn("responses.stream", failing)

    def test_corrupt_sse_framing_is_detected(self):
        self.assertEqual(self.failing(self.run_with(corrupt_frame=1))["chat.stream"], "protocol")

    def test_cross_request_contamination_fails_concurrency_isolation(self):
        self.assertEqual(self.failing(self.run_with(shared_token=True))["chat.concurrency_isolation"], "assertion")

    def test_critical_failure_makes_the_model_unhealthy_and_noncritical_degrades(self):
        self.assertEqual(self.run_with(drop_tool_ids=True)["status"], "unhealthy")
        self.assertEqual(self.run_with(shared_token=True)["status"], "degraded")

    def test_failed_check_does_not_advance_last_success(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state.json"
            with support.served() as (emulator, base):
                first = support.run(emulator, base, "light", state_path=str(state), clock=lambda: "T1")
                emulator.fault(model_status={OPUS: 503})
                second = support.run(emulator, base, "light", state_path=str(state), clock=lambda: "T2")
            self.assertEqual(support.model(first, OPUS)["last_success"]["healthy_at"], "T1")
            failed = support.model(second, OPUS)
            self.assertEqual(failed["status"], "unhealthy")
            self.assertEqual(failed["last_success"]["healthy_at"], "T1")
            self.assertEqual(support.model(second, SOL)["last_success"]["healthy_at"], "T2")
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o600)


class ReadinessAndLiveness(unittest.TestCase):
    def test_wrong_key_is_an_auth_failure_and_models_stay_unknown(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "light", key="wrong-key-value-000000")
        self.assertEqual(report["levels"]["readiness"]["category"], "auth")
        self.assertEqual({m["status"] for m in report["models"]}, {"unknown"})
        self.assertEqual(report["summary"]["status"], "unhealthy")
        self.assertEqual(emulator.requests, 0)  # no inference attempted

    def test_missing_credentials_is_unknown_not_healthy(self):
        with support.served() as (emulator, base):
            report = runner.run(support.load(), "light", "all", base, None, "mock", seed=1)
        self.assertEqual(report["levels"]["readiness"]["category"], "credentials")
        self.assertEqual(report["summary"]["status"], "unknown")
        self.assertEqual(cli.exit_code("unknown", "unhealthy", False), 2)
        self.assertEqual(cli.exit_code("unknown", "unhealthy", True), 0)

    def test_liveness_needs_no_credentials_and_spends_nothing(self):
        with support.served() as (emulator, base):
            report = runner.run(support.load(), "liveness", "all", base, None, "mock", seed=1)
            self.assertEqual(emulator.requests, 0)
        self.assertEqual(report["summary"]["status"], "healthy")
        self.assertEqual(report["levels"]["liveness"]["probes"]["api_rejects_anonymous"]["http_status"], 401)
        self.assertNotIn("readiness", report["levels"])

    def test_unreachable_endpoint_is_a_transport_failure(self):
        report = runner.run(support.load(), "readiness", "all", "http://127.0.0.1:1/v1", "k" * 12, "mock", seed=1)
        self.assertEqual(report["levels"]["liveness"]["category"], "transport")
        self.assertEqual(report["levels"]["readiness"]["status"], "unknown")
        self.assertEqual(report["summary"]["status"], "unhealthy")

    def test_open_api_is_unhealthy(self):
        with support.served() as (emulator, base):
            emulator.open_api = True
            report = runner.run(support.load(), "liveness", "all", base, None, "mock", seed=1)
        self.assertEqual((report["levels"]["liveness"]["status"], report["levels"]["liveness"]["category"]), ("unhealthy", "auth"))
        self.assertEqual(report["summary"]["status"], "unhealthy")

    def test_unknown_model_id_filter_is_rejected(self):
        with support.served() as (emulator, base), self.assertRaises(ValueError):
            support.run(emulator, base, "light", model_ids=["typo-model"])


class Simulations(unittest.TestCase):
    def test_a_wrong_expectation_fails_the_scenario(self):
        config = support.load()
        scenario = dict(next(s for s in config.raw["simulations"] if s["id"] == "failover_after_quota"))
        scenario["steps"] = [{"request": {"protocol": "chat"}, "count": 1, "expect": {"status": 200, "served_by_all": ["acct-a"]}}]
        self.assertEqual(simulate.run_scenario(config, scenario)["status"], "fail")

    def test_hidden_retries_would_be_caught(self):
        config = support.load()
        scenario = {"id": "x", "capability": "limits.rate_limit", "title": "t", "accounts": [{"id": "a"}],
                    "steps": [{"request": {"protocol": "chat"}, "count": 2, "expect": {"status": 200, "no_retry": True}}]}
        self.assertEqual(simulate.run_scenario(config, scenario)["status"], "pass")

    def test_routing_decisions_are_recorded_per_request(self):
        config = support.load()
        result = simulate.run_scenario(config, next(s for s in config.raw["simulations"] if s["id"] == "failover_after_quota"))
        self.assertEqual(result["routing"][0]["tried"], [("acct-a", "quota"), ("acct-b", "served")])


class CommandLine(unittest.TestCase):
    def setUp(self):
        patcher = support.hermetic_environment()
        self.addCleanup(patcher.stop)

    def invoke(self, *args, default="light"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(list(args), default)
        return code, out.getvalue(), err.getvalue()

    def test_light_mock_run_prints_human_report_and_writes_both_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            code, out, _ = self.invoke("--target", "mock", "--seed", "1", "--output", directory)
            self.assertEqual(code, 0)
            self.assertIn("# CLIProxyAPI model health: HEALTHY", out)
            written = json.loads((pathlib.Path(directory) / "model-health.json").read_text())
            self.assertEqual(written["schema"], "cliproxy-model-health/1")
            self.assertTrue((pathlib.Path(directory) / "model-health.md").read_text().startswith("# CLIProxyAPI"))

    def test_suite_command_defaults_to_nightly_and_json_is_machine_readable(self):
        code, out, _ = self.invoke("--target", "mock", "--json", "--suite", "cursor", default="nightly")
        report = json.loads(out)
        self.assertEqual((code, report["profile"], report["suite"]), (0, "nightly", "cursor"))
        ids = {c["capability"] for m in report["models"] for c in m["checks"]}
        self.assertIn("responses.tools_stream", ids)
        self.assertNotIn("chat.developer", ids)

    def test_invalid_config_and_unknown_model_id_exit_with_usage_code(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = pathlib.Path(directory) / "bad.json"
            bad.write_text(json.dumps({"schema": 2}))
            self.assertEqual(self.invoke("--config", str(bad))[0], 3)
        self.assertEqual(self.invoke("--target", "mock", "--model", "nope")[0], 3)

    def test_key_resolution_prefers_environment_and_never_prints(self):
        config = support.load()
        os.environ["CLIPROXY_API_KEY"] = "env-provided-key-value"
        self.assertEqual(cli.resolve_key(config, offline=False), "env-provided-key-value")
        self.assertIsNone(cli.resolve_key(config, offline=True))

    def test_mock_target_ignores_ambient_credentials_and_never_prints_them(self):
        os.environ["CLIPROXY_API_KEY"] = "ambient-secret-key-do-not-use"
        os.environ["VAULT_TOKEN"] = "hvs.ambient-vault-token-do-not-use"
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:9"  # a proxy that would break any non-loopback client
        code, out, err = self.invoke("--target", "mock", "--json", "--profile", "light")
        self.assertEqual(code, 0)
        for leaked in ("ambient-secret-key-do-not-use", "ambient-vault-token-do-not-use"):
            self.assertNotIn(leaked, out + err)

    def test_no_key_anywhere_is_unknown_not_a_crash_or_a_pass(self):
        os.environ["CLIPROXY_ROOT"] = "/nonexistent-cliproxy-root"
        self.assertIsNone(cli.resolve_key(support.load(), offline=False))

    def test_entry_point_runs_as_a_process_with_the_documented_commands(self):
        script = support.PACKAGE / "scripts/model_health.py"
        for command in ("model-health", "model-suite"):
            done = subprocess.run([sys.executable, "-B", str(script), command, "--target", "mock", "--profile", "readiness", "--json"],
                                  capture_output=True, text=True, timeout=60, env=support.child_environment(), cwd="/")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(json.loads(done.stdout)["profile"], "readiness")

    def test_cli_dispatch_and_workflows_use_the_commands(self):
        dispatch = (support.PACKAGE / "scripts/cli.py").read_text()
        self.assertIn("model-health", dispatch)
        self.assertIn("model-suite", dispatch)
        workflow = (support.PACKAGE / "docs/health-workflow.example.yml").read_text()
        for needle in ("scripts/model_health.py", "command=model-health", "command=model-suite", "'nightly'", "'light'",
                       "manual", "--fail-on", "--state", "cron: '41 3 * * *'", "external-health.py"):
            self.assertIn(needle, workflow)
        self.assertNotIn("max-parallel", workflow)
        self.assertNotIn("echo $VAULT_TOKEN", workflow)

    def test_workflow_keeps_pull_requests_offline_and_inference_hourly_at_most(self):
        workflow = (support.PACKAGE / "docs/health-workflow.example.yml").read_text()
        contract, health = workflow.split("\n  health:\n")
        contract = contract.split("\n  contract:\n")[1]
        for forbidden in ("vault-action", "id-token", "VAULT_TOKEN", "issues: write", "--profile light", "--profile nightly"):
            self.assertNotIn(forbidden, contract)
        self.assertIn("--target mock", contract)
        self.assertIn("github.event_name != 'pull_request'", health)
        self.assertIn("issues: write", health)
        crons = [line.split("cron:")[1].strip(" '\n") for line in workflow.splitlines() if "cron:" in line]
        self.assertEqual(crons, ["7,22,37,52 * * * *", "17 * * * *", "41 3 * * *"])
        self.assertIn("github.event.schedule == '17 * * * *' && 'light'", workflow)  # inference only on the hourly cron
        self.assertIn("|| 'readiness'", workflow)  # the 15-minute cron is free


if __name__ == "__main__":
    unittest.main()
