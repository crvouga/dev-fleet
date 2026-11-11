"""Explicit host dispatch for the singleton proxy.

The manager (macOS) hosts the proxy with per-user launchd agents and Docker
Desktop; no sudo. Linux systemd hosting is legacy and kept for fencing and
decommissioning the previous owner. Everything here is pure or takes injected
commands so it can be tested offline.
"""

import sys

sys.dont_write_bytecode = True

import os
import pathlib
import re
import socket
import subprocess

LINUX_ROOT = pathlib.Path("/opt/cliproxy-fleet")
# The tracked LaunchAgents reference this path relative to $HOME.
MACOS_ROOT = "Library/Application Support/cliproxy-fleet"
LINUX_IDS = (1000, 1000)
# Base PATH of the tracked LaunchAgents. Each agent puts the install's
# tools/bin (pinned python3 + PyYAML venv, pinned restic) in front of it.
LAUNCHD_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Docker.app/Contents/Resources/bin"
LAUNCHD_TOOLS = "$HOME/Library/Application Support/cliproxy-fleet/tools/bin"
DOCKER_DESKTOP_BIN = "/Applications/Docker.app/Contents/Resources/bin"
DOCKER_UNAVAILABLE = 69  # EX_UNAVAILABLE

SYSTEMD_SERVICE = "cliproxy-fleet.service"
SYSTEMD_SCHEDULED = [
    "cliproxy-monitor.timer",
    "cliproxy-vault-renew.timer",
    "cliproxy-backup.timer",
    "cliproxy-backup-check.timer",
    "cliproxy-gc.timer",
]
LAUNCHD_SERVICE = "dev.devfleet.cliproxy-fleet"
LAUNCHD_SCHEDULED = [
    "dev.devfleet.cliproxy-monitor",
    "dev.devfleet.cliproxy-vault-renew",
    "dev.devfleet.cliproxy-backup",
    "dev.devfleet.cliproxy-backup-check",
    "dev.devfleet.cliproxy-gc",
]


def system(platform=None):
    platform = platform or sys.platform
    if platform == "darwin":
        return "macos"
    if platform.startswith("linux"):
        return "linux"
    raise ValueError("Unsupported proxy host platform")


def default_root(environ=None, platform=None, home=None):
    """CLIPROXY_ROOT wins; otherwise the platform's installation root."""
    environ = os.environ if environ is None else environ
    if environ.get("CLIPROXY_ROOT"):
        return pathlib.Path(environ["CLIPROXY_ROOT"])
    if system(platform) == "macos":
        return pathlib.Path(home or pathlib.Path.home()) / MACOS_ROOT
    return LINUX_ROOT


def runtime_ids(platform=None):
    """Container/state owner: the installing user on macOS, UID/GID 1000 on Linux."""
    if system(platform) == "macos":
        return os.getuid(), os.getgid()
    return LINUX_IDS


def runtime_home(platform=None):
    if system(platform) == "macos":
        return pathlib.Path.home()
    import pwd

    return pathlib.Path(pwd.getpwuid(LINUX_IDS[0]).pw_dir)


def normalize_node(name):
    name = name.strip().lower()
    name = name.removesuffix(".local")
    return re.sub(r"[^a-z0-9-]", "-", name)


def local_node_id(platform=None, output=subprocess.check_output):
    """macOS LocalHostName (scutil) or the Linux hostname, normalized."""
    if system(platform) == "macos":
        name = output(["scutil", "--get", "LocalHostName"], text=True, timeout=10)
    else:
        name = socket.gethostname()
    return normalize_node(name)


def _executable(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def _reachable(path):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(2)
    try:
        connection.connect(path)
        return True
    except OSError:
        return False
    finally:
        connection.close()


class DockerUnavailable(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def docker_invocation(
    args,
    wrapper,
    platform=None,
    environ=None,
    home=None,
    executable=_executable,
    reachable=_reachable,
):
    """Return (argv, environment) for the real Docker CLI behind the tracked wrapper."""
    environ = dict(os.environ if environ is None else environ)
    if system(platform) == "linux":
        if os.access("/var/run/docker.sock", os.R_OK | os.W_OK):
            return ["/usr/bin/docker", *args], environ
        return ["sudo", "-n", "/usr/bin/docker", *args], environ
    home = pathlib.Path(home or pathlib.Path.home())
    own = os.path.realpath(wrapper)
    candidates = [
        os.path.join(directory, "docker")
        for directory in environ.get("PATH", "").split(os.pathsep)
        if directory
    ] + [
        str(home / ".docker/bin/docker"),
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        DOCKER_DESKTOP_BIN + "/docker",
        str(home / ".local/share/mise/shims/docker"),
    ]
    binary = next(
        (
            path
            for path in candidates
            if executable(path) and os.path.realpath(path) != own
        ),
        None,
    )
    if binary is None:
        raise DockerUnavailable(
            "DOCKER_CLI_MISSING",
            "DOCKER_CLI_MISSING: install Docker Desktop (it provides the docker CLI).",
        )
    host = environ.get("DOCKER_HOST", "")
    if host and not host.startswith("unix://"):
        socket_path = None  # Remote engines are the operator's explicit choice.
    elif host:
        socket_path = host.removeprefix("unix://")
        if not reachable(socket_path):
            socket_path = ""
    else:
        socket_path = next(
            (
                path
                for path in [str(home / ".docker/run/docker.sock"), "/var/run/docker.sock"]
                if reachable(path)
            ),
            "",
        )
        if socket_path and not environ.get("DOCKER_CONTEXT"):
            environ["DOCKER_HOST"] = "unix://" + socket_path
    if socket_path == "":
        raise DockerUnavailable(
            "DOCKER_DESKTOP_NOT_RUNNING",
            "DOCKER_DESKTOP_NOT_RUNNING: start Docker Desktop and enable "
            "'Start Docker Desktop when you sign in'; nothing was changed.",
        )
    # Credential helpers (docker-credential-desktop) live beside the CLI.
    environ["PATH"] = os.pathsep.join(
        [os.path.dirname(binary), DOCKER_DESKTOP_BIN, environ.get("PATH", "")]
    )
    return [binary, *args], environ


class Systemd:
    """Legacy Linux owner backend: fencing/decommission of the previous host."""

    name = "systemd"
    service = SYSTEMD_SERVICE
    scheduled = SYSTEMD_SCHEDULED
    recovery_gated = set(SYSTEMD_SCHEDULED[2:])
    units = [SYSTEMD_SERVICE, *SYSTEMD_SCHEDULED]
    unit_directory = pathlib.Path("/etc/systemd/system")
    source_directory = "systemd"

    def state(self, unit, run):
        return (
            run(["systemctl", "is-active", "--quiet", unit]),
            run(["systemctl", "is-enabled", "--quiet", unit]),
        )

    def enable(self, unit):
        return [["sudo", "-n", "systemctl", "enable", "--now", unit]]

    def install(self, python, scripts, revision):
        return ["sudo", "-n", python, "-B", str(scripts / "install.py"), "--revision", revision]


class Launchd:
    """Manager owner backend: per-user LaunchAgents in gui/$UID, no root."""

    name = "launchd"
    service = LAUNCHD_SERVICE
    scheduled = LAUNCHD_SCHEDULED
    recovery_gated = set(LAUNCHD_SCHEDULED[2:])
    # Load scheduled agents first: service-start's audit expects them loaded.
    units = [*LAUNCHD_SCHEDULED, LAUNCHD_SERVICE]
    source_directory = "launchd"

    def __init__(self, uid=None, home=None):
        self.uid = os.getuid() if uid is None else uid
        self.home = pathlib.Path(home or pathlib.Path.home())
        self.domain = "gui/" + str(self.uid)
        self.unit_directory = self.home / "Library/LaunchAgents"

    def plist(self, label):
        return self.unit_directory / (label + ".plist")

    def loaded(self, label, run):
        return run(["launchctl", "print", self.domain + "/" + label])

    def state(self, unit, run):
        loaded = self.loaded(unit, run)
        return loaded, loaded and self.plist(unit).is_symlink()

    def enable(self, unit):
        # A prior `launchctl disable` persists; clear it before loading.
        return [
            ["launchctl", "enable", self.domain + "/" + unit],
            ["launchctl", "bootstrap", self.domain, str(self.plist(unit))],
        ]

    def bootout(self, unit):
        return ["launchctl", "bootout", self.domain + "/" + unit]

    def install(self, python, scripts, revision):
        return [python, "-B", str(scripts / "install.py"), "--revision", revision]


def backend(platform=None):
    return Launchd() if system(platform) == "macos" else Systemd()
