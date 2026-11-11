import copy
import json
import random
import unittest

import modelhealth_support as support
from modelhealth import config as configuration
from modelhealth import schema


class DeclarativeConfiguration(unittest.TestCase):
    def test_shipped_configuration_is_valid_and_requires_the_four_model_ids(self):
        config = support.load()
        self.assertEqual(
            [m["id"] for m in config.models],
            ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6.1-sol"],
        )
        self.assertEqual(config.raw["endpoint"]["base_url"], "https://cli-proxy.example.com/v1")

    def test_every_model_classifies_every_capability(self):
        config = support.load()
        for model in config.models:
            for capability in config.capabilities:
                self.assertIn(config.state(model, capability)[0], configuration.STATES)

    def test_adding_a_model_needs_only_configuration(self):
        def add(raw):
            raw["models"].append({"id": "new-vendor-model", "provider": "other", "profile": "frontier-agent",
                                  "capabilities": {"*.tools*": {"state": "unsupported", "reason": "No function calling."}}})

        config = support.load(add)
        with support.served(support.MODEL_IDS + ["new-vendor-model"]) as (emulator, base):
            report = support.run(emulator, base, "nightly", config=config)
        new = support.model(report, "new-vendor-model")
        self.assertEqual(new["capabilities"]["chat.tools"]["result"], "unsupported")
        self.assertEqual(new["capabilities"]["chat.tools"]["reason"], "No function calling.")
        self.assertEqual(new["capabilities"]["chat.basic"]["result"], "pass")
        self.assertEqual(new["status"], "healthy")

    def test_invalid_configuration_is_rejected_with_every_problem(self):
        cases = {
            "duplicate model_id": lambda r: r["models"].append(copy.deepcopy(r["models"][0])),
            "unknown pattern": lambda r: r["models"][0]["capabilities"].update({"chat.nope": "optional"}),
            "unsupported without reason": lambda r: r["models"][0]["capabilities"].update({"chat.tools": {"state": "unsupported"}}),
            "inference retries": lambda r: r["retry"].update(inference=2),
            "bad tier": lambda r: r["checks"][0].update(tier="sometimes"),
            "unknown placeholder": lambda r: r["checks"][0]["turn"]["messages"][0].update(content="Hi {secret}"),
            "plain http": lambda r: r["endpoint"].update(base_url="http://example.com/v1"),
            "missing tool": lambda r: r["checks"][6]["turn"].update(tools=["absent"]),
            "no diagnostics": lambda r: r["diagnostics"].pop("auth"),
            "uncovered simulation": lambda r: r.update(simulations=r["simulations"][1:]),
        }
        for name, mutate in cases.items():
            with self.subTest(name), self.assertRaises(configuration.ConfigError):
                support.load(mutate)

    def test_budgets_and_tiers_scale_with_profile(self):
        config = support.load()
        light = {c.capability for c in config.cases_for("all", "light")}
        self.assertEqual(light, {"chat.basic", "responses.stream"})
        nightly = {c.capability for c in config.cases_for("all", "full")}
        self.assertTrue(light < nightly)
        self.assertNotIn("chat.invalid_key", nightly)
        self.assertIn("chat.invalid_key", {c.capability for c in config.cases_for("all", "manual")})
        cursor = {c.capability for c in config.cases_for("cursor", "full")}
        self.assertIn("responses.tools_stream", cursor)
        self.assertNotIn("chat.developer", cursor)


class SchemaValidator(unittest.TestCase):
    def sample(self, rng, spec):
        kind = spec["type"]
        if kind == "object":
            return {k: self.sample(rng, v) for k, v in spec["properties"].items()}
        if kind == "array":
            return [self.sample(rng, spec["items"]) for _ in range(rng.randint(spec.get("minItems", 0), 3))]
        if kind == "integer":
            return rng.randint(spec.get("minimum", -5), spec.get("maximum", 5))
        if "enum" in spec:
            return rng.choice(spec["enum"])
        return "x" * rng.randint(spec.get("minLength", 0), 6)

    def test_generated_valid_instances_pass_and_mutations_fail(self):
        for name, tool in support.RAW["tools"].items():
            spec = tool["parameters"]
            rng = random.Random(name)
            for _ in range(100):
                value = {k: v for k, v in self.sample(rng, spec).items()}
                if "pattern" in str(spec):
                    value = {k: ("ABC-1234" if "token" == k else v) for k, v in value.items()}
                self.assertEqual(schema.errors(value, spec), [], (name, value))
                for required in spec["required"]:
                    broken = {k: v for k, v in value.items() if k != required}
                    self.assertTrue(schema.errors(broken, spec))
                self.assertTrue(schema.errors(dict(value, unexpected=1), spec))
                self.assertTrue(schema.errors("not an object", spec))

    def test_keywords(self):
        self.assertTrue(schema.errors(3, {"type": "string"}))
        self.assertTrue(schema.errors(True, {"type": "integer"}))
        self.assertTrue(schema.errors("a", {"enum": ["b"]}))
        self.assertTrue(schema.errors(-1, {"type": "number", "minimum": 0}))
        self.assertTrue(schema.errors([], {"type": "array", "minItems": 1}))
        self.assertTrue(schema.errors("abc", {"type": "string", "pattern": "^[0-9]+$"}))
        self.assertEqual(schema.errors(None, {"type": ["string", "null"]}), [])


if __name__ == "__main__":
    unittest.main()
