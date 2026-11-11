"""Synthetic off-machine monitoring and fail-safe recovery; no production reads."""

import contextlib
import datetime
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import unittest
from unittest import mock

import test_checkpoint as fixtures

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"


def load(name, file=None):
    spec = importlib.util.spec_from_file_location(
        name, SCRIPTS / (file or (name + ".py"))
    )
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, MODULES):
        spec.loader.exec_module(module)
    return module


MODULES = {"checkpoint": fixtures.checkpoint}
cloud = load("cloud_state")
MODULES["cloud_state"] = cloud
health = load("external_health", "external-health.py")
recovery = load("recover_node")


class CloudOperations(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.Checkpoint()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        environment = mock.patch.dict(
            os.environ, {"CLIPROXY_ROOT": str(self.fixture.root)}
        )
        environment.start()
        self.addCleanup(environment.stop)
        self.root = self.fixture.directory
        self.destination = self.root / "replacement"
        self.token = self.root / "token"
        self.token.write_text("synthetic-vault-token")
        self.token.chmod(0o600)
        self.data = {name: "synthetic-value" for name in cloud.FIELDS}
        self.data.update(
            S3_ENDPOINT="https://storage.example.invalid",
            S3_BUCKET="fixture",
            S3_REGION="auto",
            CLIPROXY_FLEET_CLIENT_API_KEY="c" * 32,
        )
        (self.fixture.state / "repository.json").write_text(
            json.dumps(
                {
                    key: self.data[key]
                    for key in ("S3_ENDPOINT", "S3_BUCKET", "S3_REGION")
                }
            )
        )
        self.fixture.capture()
        self.calls = []
        self.snapshot = {
            "id": "a" * 64,
            "time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "paths": ["/source/payload"],
        }
        self.gc_time = self.snapshot["time"]

    def restic(self, *args):
        self.calls.append(args)
        if args[0] == "snapshots":
            return json.dumps([self.snapshot])
        if args[0] == "dump":
            return json.dumps({"time": self.gc_time})
        if args[0] == "restore":
            target = pathlib.Path(args[args.index("--target") + 1]) / "source/payload"
            shutil.copytree(self.fixture.target, target)
            return ""
        raise AssertionError("Unexpected cloud mutation or service command")

    def recover(self, **kwargs):
        with mock.patch.object(recovery, "verify_source") as verify:
            result = recovery.recover(
                self.destination,
                self.token,
                restic_factory=lambda data: self.restic,
                read_settings=lambda token: self.data,
                **kwargs,
            )
            verify.assert_called_once()
            return result

    def test_complete_recovery_preserves_source_and_never_activates_services(self):
        before = self.token.read_bytes()
        self.assertEqual(self.recover(), "a" * 64)
        self.assertEqual(self.token.read_bytes(), before)
        self.assertEqual([call[0] for call in self.calls], ["snapshots", "restore"])
        self.assertEqual(
            self.calls[-1][1], "a" * 64
        )  # Pin one snapshot, not a moving 'latest'.
        self.assertEqual(
            (self.destination / "state/secrets/vault-token").read_text().strip(),
            "synthetic-vault-token",
        )
        self.assertEqual(
            (self.destination / "state/secrets/client-key").stat().st_mode & 0o777,
            0o600,
        )
        self.assertFalse(
            json.loads((self.destination / "RECOVERY.json").read_text())["activated"]
        )
        self.assertTrue((self.fixture.state / "runtime/config.yaml").exists())
        self.assertFalse(list(self.root.glob(".cliproxy-recover-*")))

    def test_existing_destination_or_public_token_refused_before_cloud_access(self):
        self.destination.mkdir()
        with self.assertRaises(ValueError):
            self.recover()
        self.assertEqual(self.calls, [])
        self.destination.rmdir()
        self.token.chmod(0o644)
        with self.assertRaises(ValueError):
            self.recover()
        self.assertEqual(self.calls, [])

    def test_incomplete_restore_mismatched_keys_or_repository_never_published(self):
        for failure in (
            "corruption",
            "key",
            "repository",
            "source-verification",
            "download",
        ):
            with self.subTest(failure=failure):
                data = dict(self.data)

                def factory(settings):
                    def run(*args):
                        if failure == "download" and args[0] == "restore":
                            raise RuntimeError("synthetic-secret upstream response")
                        result = self.restic(*args)
                        if failure == "corruption" and args[0] == "restore":
                            target = pathlib.Path(args[args.index("--target") + 1])
                            next(target.rglob("config.yaml")).write_text("corrupted")
                        return result

                    return run

                if failure == "key":
                    data["CLIPROXY_FLEET_CLIENT_API_KEY"] = "different"
                if failure == "repository":
                    data["S3_BUCKET"] = "different"
                with mock.patch.object(
                    recovery,
                    "verify_source",
                    side_effect=ValueError("bad Git manifest")
                    if failure == "source-verification"
                    else None,
                ):
                    with self.assertRaises((ValueError, RuntimeError)):
                        recovery.recover(
                            self.destination,
                            self.token,
                            restic_factory=factory,
                            read_settings=lambda token: data,
                        )
                self.assertFalse(self.destination.exists())
                self.assertFalse(list(self.root.glob(".cliproxy-recover-*")))
                self.assertEqual(self.token.read_text(), "synthetic-vault-token")

    def test_atomic_publication_does_not_replace_competing_directory(self):
        candidate = self.root / "candidate"
        candidate.mkdir()
        (candidate / "data").write_text("synthetic")
        self.destination.mkdir()
        with self.assertRaises(OSError):
            recovery.publish(candidate, self.destination)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertTrue((candidate / "data").exists())
        self.destination.rmdir()
        recovery.publish(candidate, self.destination)
        self.assertFalse(candidate.exists())
        self.assertTrue((self.destination / "data").exists())

    def test_cloud_monitor_rejects_stale_missing_future_or_bad_cleanup_status(self):
        health.cloud_health(self.restic)
        self.assertEqual(
            self.calls[-1],
            ("dump", "a" * 64, "/source/payload/state/status/gc-success.json"),
        )
        for days in (-1, 10):
            self.gc_time = (
                datetime.datetime.now(datetime.timezone.utc)
                - datetime.timedelta(days=days)
            ).isoformat()
            with self.assertRaises(ValueError):
                health.cloud_health(self.restic)
        self.gc_time = self.snapshot["time"]
        self.snapshot["time"] = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=46)
        ).isoformat()
        with self.assertRaises(ValueError):
            health.cloud_health(self.restic)
        with self.assertRaises(ValueError):
            cloud.latest(lambda *args: "[]")
        self.snapshot["id"] = "--unsafe"
        with self.assertRaises(ValueError):
            cloud.latest(self.restic)

    def test_endpoint_checks_fail_closed_for_empty_models_and_auth_regressions(self):
        for failure in (
            None,
            "anonymous",
            "empty",
            "dashboard",
            "redirect",
        ):

            def request(url, headers):
                authenticated = bool(headers)
                if url.endswith("/v1/models"):
                    if not authenticated:
                        return (200 if failure == "anonymous" else 401), b""
                    return (302 if failure == "redirect" else 200), json.dumps(
                        {"data": [] if failure == "empty" else [{"id": "fixture"}]}
                    ).encode()
                if url.endswith("/v0/management/config"):
                    raise AssertionError(
                        "Scheduled monitoring must not attempt management logins"
                    )
                return (503 if failure == "dashboard" else 200), b"panel"

            if failure is None:
                health.endpoint_health("https://example.invalid", "synthetic", request)
            else:
                with self.subTest(failure=failure), self.assertRaises(ValueError):
                    health.endpoint_health(
                        "https://example.invalid", "synthetic", request
                    )

    def test_restic_does_not_inherit_alternate_passwords_destinations_or_sessions(self):
        with mock.patch.dict(
            os.environ,
            {
                "RESTIC_PASSWORD_COMMAND": "unsafe",
                "AWS_SESSION_TOKEN": "stale",
                "VAULT_TOKEN": "synthetic",
            },
        ):
            environment = cloud.restic_environment(self.data)
        self.assertNotIn("RESTIC_PASSWORD_COMMAND", environment)
        self.assertNotIn("AWS_SESSION_TOKEN", environment)
        self.assertNotIn("VAULT_TOKEN", environment)
        self.assertTrue(
            environment["RESTIC_REPOSITORY"].endswith("/fixture/cliproxy-fleet/restic")
        )
        self.assertIsNone(
            cloud.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://attacker.invalid"
            )
        )

    def test_cloud_client_cannot_mutate_repository(self):
        with mock.patch.object(cloud.subprocess, "run") as run:
            client = cloud.client(self.data)
            for command in ("init", "forget", "prune", "unlock", "backup"):
                with self.assertRaises(ValueError):
                    client(command)
            run.assert_not_called()
            client("snapshots", "--json")
            self.assertIn("--no-lock", run.call_args.args[0])

    def test_recovery_cannot_publish_inside_live_mount_even_through_parent_symlink(
        self,
    ):
        alias = self.root / "alias"
        alias.symlink_to(self.fixture.state / "runtime", target_is_directory=True)
        with mock.patch.dict(os.environ, {"CLIPROXY_ROOT": str(self.fixture.root)}):
            for destination in (self.fixture.state / "runtime/new", alias / "new"):
                with mock.patch.object(cloud, "settings") as settings:
                    with self.assertRaises(ValueError):
                        recovery.recover(
                            destination, self.token, read_settings=settings
                        )
                    settings.assert_not_called()
                self.assertFalse(destination.exists())
