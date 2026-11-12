"""Fault injection uses synthetic credentials only; never reads the deployed service."""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest import mock

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "checkpoint", PACKAGE / "scripts/checkpoint.py"
)
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


class Checkpoint(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.root = self.directory / "source"
        self.target = self.directory / "payload"
        self.state = self.root / "state"
        (self.state / "runtime/auths").mkdir(parents=True)
        (self.state / "runtime/static").mkdir()
        (self.state / "runtime/static/management.html").write_text("synthetic panel")
        config = (
            (PACKAGE / "config.template.yaml")
            .read_text()
            .replace("REPLACE_CLIENT_KEY", "c" * 32)
            .replace("REPLACE_MANAGEMENT_KEY", "m" * 32)
        )
        (self.state / "runtime/config.yaml").write_text(config)
        (self.state / "runtime/auths/provider.json").write_text(
            json.dumps({"refresh_token": "synthetic-refresh"})
        )
        (self.state / "runtime/auths/kv.db").write_bytes(b"synthetic-bbolt\x00\xff")
        (self.state / "runtime/auths/provider.json.lock").touch()
        (self.state / "runtime/auths/provider.cds").write_text(
            json.dumps({"version": 1, "records": []})
        )
        (self.state / "runtime/auths/logs").mkdir()
        (self.state / "runtime/auths/logs/error-v1.log").write_text("MUST-NOT-BE-SAVED")
        (self.state / "tailscale").mkdir()
        (self.state / "tailscale/tailscaled.state").write_text("synthetic identity")
        (self.state / "repository.json").write_text('{"S3_BUCKET":"fixture"}')
        (self.state / "secrets").mkdir()
        (self.state / "secrets/vault-token").write_text("MUST-NOT-BE-SAVED")
        (self.state / "runtime/logs").mkdir()
        (self.state / "runtime/logs/request.log").write_text("MUST-NOT-BE-SAVED")
        (self.state / "runtime/config.yaml.previous").write_text("MUST-NOT-BE-SAVED")
        (self.root / "INSTALLATION.json").write_text('{"revision":"synthetic"}')

    def capture(self):
        checkpoint.capture(self.root, self.target, sleep=lambda seconds: None)

    def test_capture_excludes_secrets_logs_and_code(self):
        self.capture()
        checkpoint.validate(self.target)
        self.assertEqual(
            (self.target / "state/runtime/auths/kv.db").read_bytes(),
            b"synthetic-bbolt\x00\xff",
        )
        self.assertFalse(
            (self.target / "state/runtime/auths/provider.json.lock").exists()
        )
        self.assertFalse((self.target / "state/secrets").exists())
        self.assertFalse((self.target / "state/runtime/auths/logs").exists())
        self.assertTrue((self.target / "state/runtime/auths/provider.cds").exists())
        self.assertFalse((self.target / "state/runtime/logs").exists())
        self.assertFalse((self.target / "state/runtime/config.yaml.previous").exists())
        # The immutable capture must not change when the running process refreshes OAuth.
        (self.state / "runtime/auths/provider.json").write_text(
            '{"refresh_token":"changed"}'
        )
        self.assertEqual(
            json.loads((self.target / "state/runtime/auths/provider.json").read_text())[
                "refresh_token"
            ],
            "synthetic-refresh",
        )

    def test_capture_never_stops_the_running_stack(self):
        # Agents use the proxy around the clock; the capture takes no compose
        # handle at all, so it cannot stop, pause or restart a container.
        import inspect

        self.assertNotIn("compose", inspect.signature(checkpoint.capture).parameters)
        self.assertNotIn("compose", inspect.getsource(checkpoint.capture))
        self.assertNotIn("compose", inspect.getsource(checkpoint.copy_state))

    def test_a_file_written_during_the_copy_is_captured_again(self):
        provider = self.state / "runtime/auths/provider.json"
        original = checkpoint.copy_state
        copies = []

        def racing(root, target):
            original(root, target)
            copies.append(1)
            if len(copies) == 1:
                # The proxy refreshes a token while the copy is being taken.
                provider.write_text(json.dumps({"refresh_token": "refreshed-and-longer"}))

        with mock.patch.object(checkpoint, "copy_state", racing):
            self.capture()
        self.assertEqual(len(copies), 2)
        self.assertEqual(
            json.loads((self.target / "state/runtime/auths/provider.json").read_text())["refresh_token"],
            "refreshed-and-longer",
        )

    def test_state_that_never_holds_still_fails_the_backup(self):
        store = self.state / "runtime/auths/kv.db"
        original = checkpoint.copy_state
        writes = []

        def racing(root, target):
            original(root, target)
            writes.append(1)
            store.write_bytes(b"synthetic-bbolt" + bytes(len(writes)))

        with mock.patch.object(checkpoint, "copy_state", racing):
            with self.assertRaises(ValueError):
                self.capture()
        self.assertFalse(self.target.exists())

    def test_changing_logs_do_not_block_the_capture(self):
        log = self.state / "tailscale/tailscaled.log1.txt"
        original = checkpoint.copy_state
        copies = []

        def racing(root, target):
            original(root, target)
            copies.append(1)
            log.write_text("line " * len(copies))

        with mock.patch.object(checkpoint, "copy_state", racing):
            self.capture()
        self.assertEqual(len(copies), 1)

    def test_copy_or_validation_failure_never_returns_success(self):
        for operation in ("copyfile", "validate"):
            with self.subTest(operation=operation):
                shutil.rmtree(self.target, ignore_errors=True)
                owner = checkpoint.shutil if operation == "copyfile" else checkpoint
                with mock.patch.object(
                    owner, operation, side_effect=OSError("injected disk failure")
                ):
                    with self.assertRaises(OSError):
                        self.capture()

    def test_links_and_devices_cannot_enter_checkpoint(self):
        provider = self.state / "runtime/auths/provider.json"
        provider.unlink()
        for kind in ("symlink", "fifo"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    provider.symlink_to(self.state / "secrets/vault-token")
                else:
                    os.mkfifo(provider)
                shutil.rmtree(self.target, ignore_errors=True)
                with self.assertRaises(ValueError):
                    self.capture()
                provider.unlink()

    def test_corruption_missing_extra_files_and_bad_json_rejected(self):
        self.capture()
        original = self.directory / "original"
        shutil.copytree(self.target, original)
        for mode in ("changed", "missing", "extra", "invalid-json", "link"):
            with self.subTest(mode=mode):
                shutil.rmtree(self.target)
                shutil.copytree(original, self.target)
                provider = self.target / "state/runtime/auths/provider.json"
                if mode == "missing":
                    provider.unlink()
                elif mode == "extra":
                    (self.target / "unexpected").write_text("data")
                elif mode == "link":
                    provider.unlink()
                    provider.symlink_to("/etc/passwd")
                else:
                    provider.write_text("not JSON" if mode == "invalid-json" else "{}")
                if mode == "invalid-json":
                    (self.target / "CHECKPOINT.json").write_text(
                        json.dumps(
                            {"version": 1, "files": checkpoint.hashes(self.target)}
                        )
                    )
                destination = self.directory / "empty"
                destination.mkdir(exist_ok=True)
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    checkpoint.hydrate(self.target, destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_hydration_preserves_bootstrap_secrets_refuses_overwrite(self):
        self.capture()
        destination = self.directory / "new-host/state"
        (destination / "secrets").mkdir(parents=True)
        token = destination / "secrets/vault-token"
        token.write_text("new-host-login")
        checkpoint.hydrate(self.target, destination)
        self.assertEqual(token.read_text(), "new-host-login")
        recovered = destination / "runtime/auths/provider.json"
        self.assertEqual(recovered.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            recovered.read_bytes(),
            (self.state / "runtime/auths/provider.json").read_bytes(),
        )
        with self.assertRaises(ValueError):
            checkpoint.hydrate(self.target, destination)
        self.assertFalse((destination / "recovery-incomplete").exists())

    def test_bootstrap_repository_pin_must_match_recovered_destination(self):
        self.capture()
        destination = self.directory / "empty"
        destination.mkdir()
        repository = destination / "repository.json"
        repository.write_text('{"S3_BUCKET":"different"}')
        with self.assertRaises(ValueError):
            checkpoint.hydrate(self.target, destination)
        self.assertEqual(list(destination.iterdir()), [repository])
        repository.write_text('{"S3_BUCKET":"fixture"}')
        checkpoint.hydrate(self.target, destination)
        self.assertTrue((destination / "runtime/config.yaml").is_file())

    def test_partial_hydration_rolls_back_and_interrupted_recovery_fails_closed(self):
        self.capture()
        destination = self.directory / "empty"
        destination.mkdir()
        real_copy = shutil.copytree

        def fail(source, target, *args, **kwargs):
            if pathlib.Path(source).name == "tailscale":
                raise OSError("injected disk full")
            return real_copy(source, target, *args, **kwargs)

        with mock.patch.object(checkpoint.shutil, "copytree", side_effect=fail):
            with self.assertRaises(OSError):
                checkpoint.hydrate(self.target, destination)
        self.assertEqual(list(destination.iterdir()), [])
        (destination / "recovery-incomplete").touch()
        with self.assertRaises(ValueError):
            checkpoint.hydrate(self.target, destination)

    def test_real_encrypted_restic_round_trip_and_wrong_password(self):
        if not shutil.which("restic"):
            self.fail("Restic is required for offline recovery integration tests")
        self.capture()
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("RESTIC_", "AWS_"))
        }
        env.update(
            RESTIC_REPOSITORY=str(self.directory / "repository"),
            RESTIC_PASSWORD="synthetic-test-password",
            RESTIC_CACHE_DIR=str(self.directory / "cache"),
        )

        def restic(*args, **kwargs):
            return subprocess.run(
                ["restic", *args],
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
                **kwargs,
            )

        self.assertEqual(restic("init").returncode, 0)
        self.assertEqual(
            restic(
                "backup",
                str(self.target),
                "--tag",
                "cliproxy-checkpoint-v1",
                "--host",
                "cliproxy-primary",
            ).returncode,
            0,
        )
        self.assertEqual(restic("check", "--read-data").returncode, 0)
        shutil.rmtree(self.root)
        shutil.rmtree(self.target)
        restored = self.directory / "restored"
        self.assertEqual(
            restic(
                "restore",
                "latest",
                "--tag",
                "cliproxy-checkpoint-v1",
                "--host",
                "cliproxy-primary",
                "--target",
                str(restored),
                "--verify",
            ).returncode,
            0,
        )
        payload = checkpoint.locate(restored)
        destination = self.directory / "replacement/state"
        destination.mkdir(parents=True)
        checkpoint.hydrate(payload, destination)
        self.assertEqual(
            json.loads((destination / "runtime/auths/provider.json").read_text())[
                "refresh_token"
            ],
            "synthetic-refresh",
        )
        env["RESTIC_PASSWORD"] = "wrong-password"
        self.assertNotEqual(restic("snapshots").returncode, 0)


class RefreshTokenRotation(unittest.TestCase):
    """A stub provider rotates refresh tokens between checkpoints."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.root = self.directory / "source"
        state = self.root / "state"
        (state / "runtime/auths").mkdir(parents=True)
        (state / "runtime/static").mkdir()
        (state / "runtime/static/management.html").write_text("synthetic panel")
        (state / "runtime/config.yaml").write_text(
            (PACKAGE / "config.template.yaml")
            .read_text()
            .replace("REPLACE_CLIENT_KEY", "c" * 32)
            .replace("REPLACE_MANAGEMENT_KEY", "m" * 32)
        )
        (self.root / "INSTALLATION.json").write_text('{"revision":"synthetic"}')
        self.auths = state / "runtime/auths"

    def sign_in(self, name, provider, token):
        (self.auths / name).write_text(
            json.dumps({"type": provider, "email": name + "@example.com", "refresh_token": token})
        )

    def checkpoint(self, name):
        target = self.directory / name
        checkpoint.capture(self.root, target, sleep=lambda seconds: None)
        return target

    def test_restoring_the_latest_checkpoint_keeps_every_account_working(self):
        self.sign_in("claude-a.json", "claude", "r1")
        self.sign_in("codex-a.json", "codex", "s1")
        self.sign_in("claude-a.json", "claude", "r2")  # the provider rotated it
        latest = self.checkpoint("latest")
        self.assertEqual(checkpoint.stale_accounts(latest, latest), [])

    def test_restoring_an_older_checkpoint_names_exactly_the_rotated_accounts(self):
        self.sign_in("claude-a.json", "claude", "r1")
        self.sign_in("claude-b.json", "claude", "q1")
        self.sign_in("codex-a.json", "codex", "s1")
        older = self.checkpoint("older")
        self.sign_in("claude-b.json", "claude", "q2")
        self.sign_in("codex-a.json", "codex", "s2")
        latest = self.checkpoint("latest")
        self.assertEqual(
            checkpoint.stale_accounts(older, latest), [("claude", 2), ("codex", 1)]
        )
        manifest = (latest / "CHECKPOINT.json").read_text()
        self.assertNotIn('"q2"', manifest)  # a digest, never the token
