"""Run safety checks as real processes, including optimized Python."""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parents[1]


class Validation(unittest.TestCase):
    def test_unsafe_configuration_rejected_even_with_optimization(self):
        template = (
            (PACKAGE / "config.template.yaml")
            .read_text()
            .replace("REPLACE_CLIENT_KEY", "c" * 32)
            .replace("REPLACE_MANAGEMENT_KEY", "m" * 32)
        )
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.yaml"
            for optimized in (False, True):
                for edit in (
                    None,
                    ("enabled: false", "enabled: true"),
                    ("debug: false", "debug: true"),
                    ("request-log: false", "request-log: true"),
                    ("switch-preview-model: false", "switch-preview-model: true"),
                    ("c" * 32, "short"),
                    ("m" * 32, "c" * 32),
                ):
                    with self.subTest(optimized=optimized, edit=edit):
                        config.write_text(template.replace(*edit) if edit else template)
                        args = [sys.executable, "-B"] + (["-O"] if optimized else [])
                        result = subprocess.run(
                            [
                                *args,
                                str(PACKAGE / "scripts/validate-config"),
                                str(config),
                            ],
                            capture_output=True,
                            text=True,
                        )
                        self.assertEqual(result.returncode == 0, edit is None)
                        self.assertNotIn("c" * 32, result.stdout + result.stderr)

    def test_missing_cache_cannot_seed_a_blank_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "state/secrets").mkdir(parents=True)
            for name in ("client-key", "management-key", "restic-password"):
                (root / "state/secrets" / name).write_text("synthetic")
            env = os.environ.copy()
            env["CLIPROXY_ROOT"] = str(root)
            result = subprocess.run(
                [sys.executable, "-B", str(PACKAGE / "scripts/initialize")],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to seed", result.stderr)
            self.assertFalse((root / "state/runtime").exists())
