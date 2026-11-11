import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


installer = module("install")
auditor = module("audit")


class Installation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = pathlib.Path(self.directory.name) / "repo"
        self.repo.mkdir()
        self.package = self.repo / installer.PACKAGE
        (self.package / "scripts").mkdir(parents=True)
        (self.package / "clients").mkdir()
        (self.package / "systemd").mkdir()
        self.write("compose.yaml", "services: {}\n")
        self.write("scripts/install.py", "# committed installer\n")
        self.write(
            "image.lock.json",
            json.dumps(
                {
                    "eceasy/cli-proxy-api": "eceasy/cli-proxy-api@sha256:" + "a" * 64,
                    "tailscale/tailscale": "tailscale/tailscale@sha256:" + "b" * 64,
                }
            ),
        )
        self.git("init", "-q")
        self.commit()
        self.target = pathlib.Path(self.directory.name) / "installed"

    def git(self, *args):
        return (
            subprocess.check_output(
                ["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE
            )
            .decode()
            .strip()
        )

    def write(self, name, text):
        path = self.package / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "test fixture",
        )

    def test_install_uses_commit_preserves_state_and_detects_drift(self):
        self.write("compose.yaml", "uncommitted content must not deploy\n")
        state = self.target / "state/runtime"
        state.mkdir(parents=True)
        (state / "auth.json").write_text("synthetic existing state")
        legacy = self.target / "scripts/tailscale-admin"
        legacy.parent.mkdir()
        legacy.write_text("retired one-off provisioning helper")
        revision, files = installer.source_files(self.repo, "HEAD")
        manifest = installer.materialize(
            self.target,
            revision,
            files,
            installer.prepare_source(self.repo, self.target, revision),
        )
        self.assertEqual((self.target / "compose.yaml").read_text(), "services: {}\n")
        self.assertEqual((state / "auth.json").read_text(), "synthetic existing state")
        self.assertFalse(legacy.exists())
        self.assertTrue((self.target / "scripts").is_symlink())
        tracked_path = (self.target / "scripts/install.py").resolve()
        self.assertIn("revisions", tracked_path.parts)
        self.assertTrue((self.target / "revisions" / revision / ".git").is_file())
        self.assertEqual(manifest["revision"], self.git("rev-parse", "HEAD"))
        self.assertEqual(auditor.audit(self.target, check_units=False)[1], [])
        (self.target / "compose.yaml").write_text("local edit")
        self.assertIn("compose.yaml", auditor.audit(self.target, check_units=False)[1])
        (self.target / "scripts/unmanaged.py").write_text("unmanaged executable")
        self.assertIn(
            "unmanaged: scripts/unmanaged.py",
            auditor.audit(self.target, check_units=False)[1],
        )

    def test_update_records_previous_revision_and_removes_retired_managed_code(self):
        self.write("scripts/retired.py", "# formerly managed\n")
        self.commit()
        old, files = installer.source_files(self.repo, "HEAD")
        installer.materialize(
            self.target,
            old,
            files,
            installer.prepare_source(self.repo, self.target, old),
        )
        (self.package / "scripts/retired.py").unlink()
        self.write("compose.yaml", "services: {proxy: {}}\n")
        self.commit()
        new, files = installer.source_files(self.repo, "HEAD")
        installer.materialize(
            self.target,
            new,
            files,
            installer.prepare_source(self.repo, self.target, new),
        )
        self.assertFalse((self.target / "scripts/retired.py").exists())
        self.assertEqual(
            json.loads((self.target / "INSTALLATION.previous.json").read_text())[
                "revision"
            ],
            old,
        )
        installer.materialize(
            self.target,
            new,
            files,
            installer.prepare_source(self.repo, self.target, new),
        )
        self.assertEqual(
            json.loads((self.target / "INSTALLATION.previous.json").read_text())[
                "revision"
            ],
            old,
        )

    def test_launchd_audit_requires_linked_and_loaded_agents(self):
        host = installer.cliproxy_host
        for label in [host.LAUNCHD_SERVICE, *host.LAUNCHD_SCHEDULED]:
            self.write("launchd/" + label + ".plist", "<plist/>\n")
        self.commit()
        revision, files = installer.source_files(self.repo, "HEAD")
        installer.materialize(
            self.target,
            revision,
            files,
            installer.prepare_source(self.repo, self.target, revision),
        )
        agents = host.Launchd(uid=501, home=pathlib.Path(self.directory.name) / "home")
        loaded = set()
        calls = []

        def run(argv):
            calls.append(argv)
            return argv[2].rsplit("/", 1)[1] in loaded

        errors = auditor.audit(self.target, backend=agents, run=run)[1]
        self.assertEqual(len([e for e in errors if "LaunchAgents" in e]), 6)
        self.assertEqual(len([e for e in errors if e.startswith("not loaded")]), 3)
        installer.link_units(self.target, agents)
        loaded.update([host.LAUNCHD_SERVICE, *host.LAUNCHD_SCHEDULED[:2]])
        self.assertEqual(auditor.audit(self.target, backend=agents, run=run)[1], [])
        self.assertTrue(all(call[:3] == ["launchctl", "print", call[2]] and call[2].startswith("gui/501/") for call in calls))
        (self.target / "state/secrets").mkdir(parents=True)
        (self.target / "state/secrets/recovery-confirmed").touch()
        self.assertEqual(
            len(auditor.audit(self.target, backend=agents, run=run)[1]), 3
        )

    def test_tracked_state_or_symlinks_are_refused(self):
        self.write("state/token", "synthetic secret must not deploy")
        self.commit()
        with self.assertRaisesRegex(ValueError, "state"):
            installer.source_files(self.repo, "HEAD")
        self.git("rm", "-r", "--", installer.PACKAGE + "/state")
        (self.package / "scripts/link").symlink_to("/etc/passwd")
        self.commit()
        with self.assertRaisesRegex(ValueError, "regular tracked files"):
            installer.source_files(self.repo, "HEAD")


if __name__ == "__main__":
    unittest.main()
