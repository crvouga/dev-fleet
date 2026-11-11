"""Offline checks for the macOS manager backend (launchd + Docker Desktop)."""

import importlib.util
import os
import pathlib
import plistlib
import re
import tempfile
import unittest
from unittest import mock

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = PACKAGE / "scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


host = module("cliproxy_host")
installer = module("install")
auditor = module("audit")


class Platform(unittest.TestCase):
    def test_root_resolution(self):
        self.assertEqual(
            host.default_root({}, "darwin", "/Users/someone"),
            pathlib.Path("/Users/someone/Library/Application Support/cliproxy-fleet"),
        )
        self.assertEqual(host.default_root({}, "linux"), pathlib.Path("/opt/cliproxy-fleet"))
        self.assertEqual(
            host.default_root({"CLIPROXY_ROOT": "/tmp/x"}, "darwin", "/Users/someone"),
            pathlib.Path("/tmp/x"),
        )
        with self.assertRaises(ValueError):
            host.system("win32")

    def test_runtime_ids(self):
        self.assertEqual(host.runtime_ids("linux"), (1000, 1000))
        self.assertEqual(host.runtime_ids("darwin"), (os.getuid(), os.getgid()))

    def test_manager_identity_uses_normalized_local_hostname(self):
        output = mock.Mock(return_value="Manager-Mac\n")
        self.assertEqual(host.local_node_id("darwin", output), "manager-mac")
        output.assert_called_once()
        self.assertEqual(output.call_args.args[0], ["scutil", "--get", "LocalHostName"])
        self.assertEqual(host.normalize_node("Manager Mac_One.local"), "manager-mac-one")

    def test_backend_dispatch(self):
        self.assertEqual(host.backend("linux").name, "systemd")
        self.assertEqual(host.backend("darwin").name, "launchd")


class Launchctl(unittest.TestCase):
    def test_argv_construction(self):
        agents = host.Launchd(uid=501, home="/Users/someone")
        plist = "/Users/someone/Library/LaunchAgents/dev.devfleet.cliproxy-gc.plist"
        self.assertEqual(
            agents.enable("dev.devfleet.cliproxy-gc"),
            [
                ["launchctl", "enable", "gui/501/dev.devfleet.cliproxy-gc"],
                ["launchctl", "bootstrap", "gui/501", plist],
            ],
        )
        self.assertEqual(
            agents.bootout("dev.devfleet.cliproxy-gc"),
            ["launchctl", "bootout", "gui/501/dev.devfleet.cliproxy-gc"],
        )
        calls = []
        agents.loaded("dev.devfleet.cliproxy-fleet", lambda argv: calls.append(argv) or True)
        self.assertEqual(calls, [["launchctl", "print", "gui/501/dev.devfleet.cliproxy-fleet"]])
        install = agents.install("/usr/bin/python3", pathlib.Path("/r/scripts"), "a" * 40)
        self.assertNotIn("sudo", install)
        self.assertEqual(host.Systemd().install("python3", pathlib.Path("/r"), "a" * 40)[:2], ["sudo", "-n"])

    def test_install_plan_unloads_everything_and_gates_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory)
            agents = host.Launchd(uid=501, home=target / "home")
            unload, load = installer.launchd_plan(target, agents)
            self.assertEqual(len(unload), 6)
            loaded = [command[3] for command in load if command[1] == "bootstrap"]
            self.assertEqual(
                [pathlib.Path(path).stem for path in loaded],
                [*host.LAUNCHD_SCHEDULED[:2], host.LAUNCHD_SERVICE],
            )
            (target / "state/secrets").mkdir(parents=True)
            (target / "state/secrets/recovery-confirmed").touch()
            _, load = installer.launchd_plan(target, agents)
            self.assertEqual(len([c for c in load if c[1] == "bootstrap"]), 6)


class TrackedAgents(unittest.TestCase):
    """The tracked plists are the launchd equivalents of the systemd units."""

    def agents(self):
        return {
            path.stem: plistlib.loads(path.read_bytes())
            for path in (PACKAGE / "launchd").glob("*.plist")
        }

    def test_labels_and_commands(self):
        agents = self.agents()
        self.assertEqual(set(agents), {host.LAUNCHD_SERVICE, *host.LAUNCHD_SCHEDULED})
        for label, agent in agents.items():
            self.assertEqual(agent["Label"], label)
            shell, flag, command = agent["ProgramArguments"]
            self.assertEqual((shell, flag), ("/bin/sh", "-c"))
            script = re.fullmatch(
                r'PATH="\$HOME/' + re.escape(host.MACOS_ROOT) + r'/tools/bin:\$PATH" '
                r'exec "\$HOME/' + re.escape(host.MACOS_ROOT) + r'/scripts/([a-z-]+)"( [a-z]+)?',
                command,
            )
            self.assertIsNotNone(script, command)
            self.assertTrue((SCRIPTS / script.group(1)).is_file())
            self.assertEqual(agent["EnvironmentVariables"]["PATH"], host.LAUNCHD_PATH)
            self.assertEqual(agent["Umask"], 0o077)
            self.assertNotIn("UserName", agent)  # Per-user agent, never root.

    def test_schedules_match_systemd_timers(self):
        agents = self.agents()
        service = agents[host.LAUNCHD_SERVICE]
        self.assertTrue(service["RunAtLoad"])
        self.assertEqual(service["KeepAlive"], {"SuccessfulExit": False})
        self.assertEqual(agents["dev.devfleet.cliproxy-monitor"]["StartInterval"], 300)
        self.assertEqual(agents["dev.devfleet.cliproxy-vault-renew"]["StartInterval"], 900)
        self.assertEqual(
            [entry["Minute"] for entry in agents["dev.devfleet.cliproxy-backup"]["StartCalendarInterval"]],
            [0, 15, 30, 45],
        )
        self.assertEqual(
            agents["dev.devfleet.cliproxy-gc"]["StartCalendarInterval"],
            {"Weekday": 0, "Hour": 4, "Minute": 0},
        )
        self.assertEqual(
            agents["dev.devfleet.cliproxy-backup-check"]["StartCalendarInterval"],
            {"Weekday": 0, "Hour": 5, "Minute": 0},
        )

    def test_dependencies_come_from_pinned_tools(self):
        text = (SCRIPTS / "install-dependencies").read_text()
        self.assertIn("mise install --quiet python uv restic", text)
        self.assertIn("--require-hashes", text)
        self.assertNotIn("brew install", text)

    def test_agents_put_pinned_tools_first(self):
        for plist in (PACKAGE / "launchd").glob("*.plist"):
            command = plistlib.loads(plist.read_bytes())["ProgramArguments"][-1]
            self.assertTrue(
                command.startswith('PATH="' + host.LAUNCHD_TOOLS + ':$PATH" exec '),
                plist.name,
            )


class DockerDesktop(unittest.TestCase):
    def setUp(self):
        self.home = "/Users/someone"
        self.wrapper = str(SCRIPTS / "docker")

    def invoke(self, executables, sockets, environ=None):
        return host.docker_invocation(
            ["compose", "ps"],
            self.wrapper,
            platform="darwin",
            environ=environ if environ is not None else {"PATH": str(SCRIPTS) + ":/usr/bin"},
            home=self.home,
            executable=lambda path: path in executables,
            reachable=lambda path: path in sockets,
        )

    def test_finds_desktop_cli_and_socket(self):
        argv, environ = self.invoke(
            {self.wrapper, "/Users/someone/.docker/bin/docker"},
            {"/Users/someone/.docker/run/docker.sock"},
        )
        self.assertEqual(argv, ["/Users/someone/.docker/bin/docker", "compose", "ps"])
        self.assertEqual(environ["DOCKER_HOST"], "unix:///Users/someone/.docker/run/docker.sock")
        self.assertTrue(environ["PATH"].startswith("/Users/someone/.docker/bin:" + host.DOCKER_DESKTOP_BIN))

    def test_never_execs_the_wrapper_itself(self):
        argv, _ = self.invoke(
            {self.wrapper, host.DOCKER_DESKTOP_BIN + "/docker"}, {"/var/run/docker.sock"}
        )
        self.assertEqual(argv[0], host.DOCKER_DESKTOP_BIN + "/docker")

    def test_explicit_context_is_respected(self):
        _, environ = self.invoke(
            {"/usr/local/bin/docker"},
            {"/Users/someone/.docker/run/docker.sock"},
            {"PATH": "/usr/bin", "DOCKER_CONTEXT": "desktop-linux"},
        )
        self.assertNotIn("DOCKER_HOST", environ)

    def test_reports_clear_codes(self):
        with self.assertRaises(host.DockerUnavailable) as stopped:
            self.invoke({"/usr/local/bin/docker"}, set())
        self.assertEqual(stopped.exception.code, "DOCKER_DESKTOP_NOT_RUNNING")
        with self.assertRaises(host.DockerUnavailable) as missing:
            self.invoke(set(), {"/var/run/docker.sock"})
        self.assertEqual(missing.exception.code, "DOCKER_CLI_MISSING")

    def test_linux_behaviour_unchanged(self):
        argv, _ = host.docker_invocation(["ps"], self.wrapper, platform="linux", environ={})
        self.assertIn(argv[:2], [["/usr/bin/docker", "ps"], ["sudo", "-n"]])


class Installation(unittest.TestCase):
    def test_macos_env_carries_installing_user_ids(self):
        files = {
            "image.lock.json": (
                0o644,
                (
                    '{"eceasy/cli-proxy-api": "eceasy/cli-proxy-api@sha256:%s",'
                    ' "tailscale/tailscale": "tailscale/tailscale@sha256:%s"}'
                    % ("a" * 64, "b" * 64)
                ).encode(),
            )
        }
        linux = installer.image_environment(files).decode()
        self.assertNotIn("CLIPROXY_UID", linux)
        macos = installer.image_environment(files, (501, 20)).decode()
        self.assertIn("CLIPROXY_UID=501\nCLIPROXY_GID=20\n", macos)
        compose = (PACKAGE / "compose.yaml").read_text()
        self.assertEqual(compose.count("user: '${CLIPROXY_UID:-1000}:${CLIPROXY_GID:-1000}'"), 3)


if __name__ == "__main__":
    unittest.main()
