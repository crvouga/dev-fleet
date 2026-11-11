"""Exercise the actual backup command with injected cloud/process failures."""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("checkpoint", SCRIPTS / "checkpoint.py")
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


spec = importlib.util.spec_from_file_location("retention", SCRIPTS / "retention.py")
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class BackupCommand(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        (self.root / "state/secrets").mkdir(parents=True)
        (self.root / "state/status").mkdir()
        (self.root / "state/secrets/recovery-confirmed").touch()
        self.previous = '{"snapshot":"previous","time":"old"}\n'
        self.success = self.root / "state/status/backup-success.json"
        self.success.write_text(self.previous)
        self.events = []
        self.credentials = dict(
            S3_ENDPOINT="https://storage.example.invalid",
            S3_BUCKET="fixture",
            S3_REGION="auto",
            S3_ACCESS_KEY_ID="first",
            S3_SECRET_ACCESS_KEY="synthetic-cloud-secret",
        )
        self.vault = types.SimpleNamespace(
            renew=mock.Mock(), credentials=lambda: dict(self.credentials)
        )
        self.fail_at = None
        self.arguments = ["backup"]
        self.active = ""
        self.keys = []

    def run_process(self, args, **kwargs):
        self.events.append(args)
        self.keys.append(kwargs["env"]["AWS_ACCESS_KEY_ID"])
        operation = args[3]
        if operation == self.fail_at:
            raise subprocess.CalledProcessError(
                1, args, stderr="synthetic-cloud-secret"
            )
        output = json.dumps(
            {"message_type": "summary", "snapshot_id": "fixture-snapshot"}
        )
        if self.fail_at == "missing-ack" and operation == "backup":
            output = '{"message_type":"status"}'
        return types.SimpleNamespace(stdout=output)

    def invoke(self):
        fake_spec = types.SimpleNamespace(
            loader=types.SimpleNamespace(exec_module=lambda module: None)
        )
        output = io.StringIO()

        def capture(root, target):
            self.events.append("capture-and-resume")
            target.mkdir()

        with (
            mock.patch.dict(os.environ, {"CLIPROXY_ROOT": str(self.root)}),
            mock.patch.dict(
                sys.modules, {"checkpoint": checkpoint, "retention": retention}
            ),
            mock.patch.object(sys, "argv", [str(SCRIPTS / "backup"), *self.arguments]),
            mock.patch(
                "importlib.util.spec_from_file_location", return_value=fake_spec
            ),
            mock.patch("importlib.util.module_from_spec", return_value=self.vault),
            mock.patch.object(checkpoint, "capture", side_effect=capture),
            mock.patch("subprocess.run", side_effect=self.run_process),
            mock.patch("subprocess.check_output", return_value=self.active),
            contextlib.redirect_stdout(output),
        ):
            try:
                runpy.run_path(str(SCRIPTS / "backup"), run_name="__main__")
            except SystemExit as error:
                output.write(str(error))
                return False, output.getvalue()
        return True, output.getvalue()

    def test_upload_failure_never_prunes_or_acknowledges_and_suppresses_secrets(self):
        self.fail_at = "backup"
        ok, output = self.invoke()
        self.assertFalse(ok)
        self.assertNotIn("synthetic-cloud-secret", output)
        self.assertEqual(self.success.read_text(), self.previous)
        self.assertTrue((self.root / "state/status/backup-failed").exists())
        self.assertEqual(self.events[0], "capture-and-resume")
        self.assertEqual(len(self.events), 2)
        self.assertEqual(list((self.root / "recovery").iterdir()), [])

    def test_missing_upload_acknowledgement_is_not_success(self):
        self.fail_at = "missing-ack"
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.success.read_text(), self.previous)
        self.assertEqual(len(self.events), 2)

    def test_current_vault_credentials_used_each_time_and_failure_cleared(self):
        (self.root / "state/status/backup-failed").touch()
        self.assertTrue(self.invoke()[0])
        self.assertEqual(self.keys, ["first", "first"])
        self.credentials["S3_ACCESS_KEY_ID"] = "rotated"
        self.keys.clear()
        self.assertTrue(self.invoke()[0])
        self.assertEqual(self.keys, ["rotated", "rotated"])
        self.assertFalse((self.root / "state/status/backup-failed").exists())
        self.assertEqual(
            json.loads(self.success.read_text())["snapshot"], "fixture-snapshot"
        )

    def test_vault_outage_and_destination_change_never_stop_service(self):
        self.vault.renew.side_effect = OSError("synthetic-cloud-secret")
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.events, [])
        self.vault.renew.side_effect = None
        (self.root / "state/repository.json").write_text('{"S3_BUCKET":"different"}')
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.events, [])
        self.assertEqual(self.success.read_text(), self.previous)

    def test_retention_failure_is_reported_without_false_freshness(self):
        self.fail_at = "forget"
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.success.read_text(), self.previous)

    def test_restore_cache_requires_fencing_and_refuses_running_stack(self):
        self.arguments = ["restore-cache"]
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.events, [])
        self.arguments.append("--previous-node-stopped")
        self.active = "proxy\n"
        self.assertFalse(self.invoke()[0])
        self.assertEqual(self.events, [])
        self.assertFalse((self.root / "state/runtime").exists())

    def test_failed_gc_does_not_claim_success_or_clear_failure_on_backup(self):
        self.arguments = ["gc"]
        with mock.patch.object(
            retention, "prune", side_effect=RuntimeError("injected prune failure")
        ):
            self.assertFalse(self.invoke()[0])
        self.assertTrue((self.root / "state/status/gc-failed").exists())
        self.assertFalse((self.root / "state/status/gc-success.json").exists())
        self.arguments = ["backup"]
        self.assertTrue(self.invoke()[0])
        self.assertTrue((self.root / "state/status/gc-failed").exists())
        self.arguments = ["gc"]
        with (
            mock.patch.object(retention, "prune"),
            mock.patch.object(retention, "revisions", return_value=0),
        ):
            self.assertTrue(self.invoke()[0])
        self.assertFalse((self.root / "state/status/gc-failed").exists())
        self.assertTrue((self.root / "state/status/gc-success.json").exists())
