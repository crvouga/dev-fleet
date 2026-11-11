"""Fill-first multi-account routing: configuration, policy parity and behavior under simulation."""

import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

import modelhealth_support as support
from modelhealth import simulate

PACKAGE = support.PACKAGE
TEMPLATE = (PACKAGE / "config.template.yaml").read_text()


def template_value(key):
    match = re.search(r"^ +%s: *(\S+)" % re.escape(key), TEMPLATE, re.M)
    return match.group(1) if match else None


class FillFirstConfiguration(unittest.TestCase):
    def test_template_uses_fill_first_with_full_failover_reach(self):
        self.assertEqual(template_value("strategy"), "fill-first")
        self.assertEqual(template_value("session-affinity"), "true")
        self.assertEqual(template_value("max-retry-credentials"), "0")  # try every eligible account
        self.assertEqual(template_value("disable-cooling"), "false")  # cooldown is what moves fill to the next

    def test_declared_health_policy_mirrors_the_template(self):
        routing = support.RAW["routing"]
        self.assertEqual(routing["strategy"], template_value("strategy"))
        self.assertEqual(str(routing["session_affinity"]).lower(), template_value("session-affinity"))

    @unittest.skipUnless(importlib.util.find_spec("yaml"), "PyYAML is required by validate-config")
    def test_apply_path_refuses_other_strategies_but_existing_config_still_validates(self):
        key, admin = "c" * 32, "m" * 32
        base = TEMPLATE.replace("REPLACE_CLIENT_KEY", key).replace("REPLACE_MANAGEMENT_KEY", admin)
        with tempfile.TemporaryDirectory() as directory:
            for strategy, flagged, expected in (("fill-first", True, True), ("round-robin", True, False),
                                                ("round-robin", False, True), ("random", False, False)):
                path = pathlib.Path(directory) / "config.yaml"
                path.write_text(base.replace("strategy: fill-first", "strategy: " + strategy))
                args = [sys.executable, "-B", str(PACKAGE / "scripts/validate-config"), str(path)]
                result = subprocess.run(args + (["--require-fill-first"] if flagged else []), capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, expected, (strategy, flagged))
                self.assertNotIn(key, result.stdout + result.stderr)

    def test_apply_and_monitor_enforce_the_policy_in_source(self):
        self.assertIn("--require-fill-first", (PACKAGE / "scripts/ops").read_text())
        self.assertIn("not fill-first", (PACKAGE / "scripts/monitor").read_text())


class FillFirstBehavior(unittest.TestCase):
    def scenario(self, name):
        return next(s for s in support.RAW["simulations"] if s["id"] == name)

    def test_declared_fill_scenarios_pass_under_the_declared_strategy(self):
        config = support.load()
        for sim in config.raw["simulations"]:
            if sim["capability"] in ("routing.fill_first", "routing.recovery", "routing.affinity"):
                with self.subTest(sim["id"]):
                    self.assertEqual(simulate.run_scenario(config, sim)["details"], [])

    def test_fill_scenarios_detect_round_robin_so_they_cannot_pass_vacuously(self):
        config = support.load()
        for name in ("fill_first_drains_one_account_before_the_next", "fill_first_does_not_spread_load",
                     "fill_first_returns_to_the_first_account_after_it_recovers"):
            with self.subTest(name):
                result = simulate.run_scenario(config, dict(self.scenario(name), strategy="round-robin"))
                self.assertEqual(result["status"], "fail")

    def test_accounts_are_drained_in_declaration_order(self):
        config = support.load()
        result = simulate.run_scenario(config, self.scenario("fill_first_drains_one_account_before_the_next"))
        served = [entry["served_by"] for entry in result["routing"]]
        self.assertEqual(served, ["acct-a"] * 3 + ["acct-b"] * 3 + ["acct-c"] * 2)
        # The exhausted account is tried once, enters cooldown, and is then skipped without being retried.
        outcomes = [dict(entry["tried"]) for entry in result["routing"]]
        self.assertEqual(outcomes[3]["acct-a"], "quota")
        self.assertEqual(outcomes[4]["acct-a"], "cooldown")

    def test_fill_first_is_the_declared_default_for_the_emulator(self):
        with support.served() as (emulator, _base):
            self.assertEqual(emulator.strategy, "fill-first")

    def test_report_states_the_policy_is_declared_not_live_verified(self):
        with support.served() as (emulator, base):
            report = support.run(emulator, base, "light")
        self.assertEqual(report["routing"]["declared"]["strategy"], "fill-first")
        self.assertFalse(report["routing"]["live_verified"])


if __name__ == "__main__":
    unittest.main()
