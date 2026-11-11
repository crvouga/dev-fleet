"""GC boundaries and real reclamation with synthetic data only."""

import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import types
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("retention", SCRIPTS / "retention.py")
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class GarbageCollection(unittest.TestCase):
    def test_gc_requires_fresh_cloud_snapshot_and_checks_before_deleting(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        for age in (0, 7200, -7200, None):
            for failure in (None, "check", "forget", "prune"):
                with self.subTest(age=age, failure=failure):
                    calls = []

                    def restic(*args, **kwargs):
                        calls.append(args)
                        if args[0] == failure:
                            raise RuntimeError("injected failure")
                        snapshots = (
                            []
                            if age is None
                            else [
                                {
                                    "time": (
                                        now - datetime.timedelta(seconds=age)
                                    ).isoformat()
                                }
                            ]
                        )
                        return types.SimpleNamespace(stdout=json.dumps(snapshots))

                    if age == 0 and failure is None:
                        retention.prune(restic, now)
                        self.assertEqual(
                            [call[0] for call in calls],
                            ["snapshots", "check", "forget", "prune", "check"],
                        )
                        policy = calls[2]
                        self.assertEqual(policy[policy.index("--group-by") + 1], "host")
                        self.assertEqual(policy[policy.index("--keep-last") + 1], "96")
                    else:
                        with self.assertRaises((ValueError, RuntimeError)):
                            retention.prune(restic, now)
                        if age != 0:
                            self.assertEqual(len(calls), 1)
                        elif failure == "check":
                            self.assertNotIn("forget", [call[0] for call in calls])
                        elif failure == "forget":
                            self.assertNotIn("prune", [call[0] for call in calls])

    def test_local_gc_preserves_recent_unknown_and_link_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            recovery = root / "recovery"
            recovery.mkdir()
            outside = root / "important"
            outside.mkdir()
            (outside / "keep").write_text("must survive")
            now = 200000.0
            for name, modified in (
                ("checkpoint-abcdefgh", 1),
                ("restore-abcdefgh", 1),
                ("checkpoint-recent12", now),
                ("manual-rollback", 1),
            ):
                path = recovery / name
                path.mkdir()
                (path / "data").write_text("fixture")
                (path / "link").symlink_to(outside, target_is_directory=True)
                os.utime(path, (modified, modified))
            (recovery / "checkpoint-symlink1").symlink_to(
                outside, target_is_directory=True
            )
            self.assertEqual(retention.staging(root, now), 2)
            self.assertTrue((outside / "keep").exists())
            self.assertTrue((recovery / "checkpoint-recent12").exists())
            self.assertTrue((recovery / "manual-rollback").exists())
            self.assertTrue((recovery / "checkpoint-symlink1").is_symlink())
            self.assertEqual(retention.staging(root, now), 0)

    def test_revisions_keep_current_previous_and_refuse_dirty_worktrees(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo = root / "source"
            repo.mkdir()

            def git(*args):
                return subprocess.check_output(
                    ["git", "-C", str(repo), *args], stderr=subprocess.PIPE, text=True
                ).strip()

            git("init", "-q")
            revisions = []
            for index in range(4):
                (repo / "file").write_text(str(index))
                git("add", "file")
                git(
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "-qm",
                    "fixture",
                )
                revision = git("rev-parse", "HEAD")
                revisions.append(revision)
                git(
                    "worktree",
                    "add",
                    "--detach",
                    str(root / "revisions" / revision),
                    revision,
                )
            (root / "INSTALLATION.json").write_text(
                json.dumps({"revision": revisions[3]})
            )
            (root / "INSTALLATION.previous.json").write_text(
                json.dumps({"revision": revisions[2]})
            )
            link = root / "client-launcher"
            link.symlink_to(root / "revisions" / revisions[0] / "file")
            self.assertEqual(retention.revisions(root, references=[link]), 1)
            self.assertTrue(link.exists())
            link.unlink()
            self.assertEqual(retention.revisions(root, references=[]), 1)
            self.assertEqual(
                {p.name for p in (root / "revisions").iterdir()}, set(revisions[2:])
            )
            git(
                "worktree",
                "add",
                "--detach",
                str(root / "revisions" / revisions[0]),
                revisions[0],
            )
            dirty = root / "revisions" / revisions[0] / "untracked"
            dirty.write_text("must survive")
            with self.assertRaises(ValueError):
                retention.revisions(root, references=[])
            self.assertTrue(dirty.exists())

    def test_real_prune_reclaims_unreferenced_bytes_and_keeps_latest_restorable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith(("RESTIC_", "AWS_"))
            }
            env.update(
                RESTIC_REPOSITORY=str(root / "repository"),
                RESTIC_PASSWORD="synthetic-password",
            )

            def restic(*args, **kwargs):
                kwargs.setdefault("stdout", subprocess.PIPE)
                kwargs.setdefault("stderr", subprocess.PIPE)
                kwargs.setdefault("text", True)
                return subprocess.run(
                    ["restic", *args, "--no-cache"],
                    env=env,
                    check=True,
                    timeout=60,
                    **kwargs,
                )

            restic("init")
            payload = root / "payload"
            payload.mkdir()
            (payload / "obsolete").write_bytes(os.urandom(2 * 1024 * 1024))
            restic(
                "backup",
                str(payload),
                "--tag",
                "cliproxy-fleet",
                "--tag",
                "cliproxy-checkpoint-v1",
                "--host",
                "cliproxy-primary",
            )
            old = json.loads(restic("snapshots", "--json").stdout)[0]["id"]
            (payload / "obsolete").unlink()
            (payload / "current").write_text("recoverable")
            restic(
                "backup",
                str(payload),
                "--tag",
                "cliproxy-fleet",
                "--tag",
                "cliproxy-checkpoint-v1",
                "--host",
                "cliproxy-primary",
            )
            restic(
                "forget", old
            )  # Simulate data expired by the periodic retention policy.

            def size():
                return sum(
                    path.stat().st_size
                    for path in (root / "repository/data").rglob("*")
                    if path.is_file()
                )

            before = size()
            retention.prune(restic)
            self.assertLess(size(), before // 2)
            restic("restore", "latest", "--target", str(root / "restored"), "--verify")
            recovered = list((root / "restored").rglob("current"))
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0].read_text(), "recoverable")
            self.assertFalse(list((root / "restored").rglob("obsolete")))
