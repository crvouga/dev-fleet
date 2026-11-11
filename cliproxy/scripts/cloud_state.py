"""Read-only cloud recovery helpers; no dependency on the running workstation."""

import datetime
import json
import os
import pathlib
import re
import subprocess
import urllib.error
import urllib.request

import sys as _sys, pathlib as _p
_sys.path.insert(0, str(_p.Path(__file__).resolve().parent))
import fleet_config


def shared_url():
    """The shared Vault document holding the proxy's keys and backup credentials."""
    vault = fleet_config.vault()
    return vault["address"] + "/v1/" + vault["shared"]

FIELDS = (
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "CLIPROXY_FLEET_RESTIC_PASSWORD",
    "CLIPROXY_FLEET_CLIENT_API_KEY",
    "CLIPROXY_FLEET_MANAGEMENT_KEY",
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a Vault token or API key to a redirect destination.


def request(url, headers=None):
    if not url.startswith("https://"):
        raise ValueError("HTTPS required")
    headers = {"User-Agent": "cliproxy-fleet/1.0", **(headers or {})}
    try:
        with urllib.request.build_opener(NoRedirect).open(
            urllib.request.Request(url, headers=headers), timeout=30
        ) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""


def settings(token):
    status, body = request(
        shared_url(), {"X-Vault-Token": token}
    )
    if status != 200:
        raise ValueError("Vault read failed")
    data = json.loads(body)["data"]["data"]
    if any(
        not isinstance(data.get(name), str) or not data[name].strip() for name in FIELDS
    ):
        raise ValueError("Cloud recovery contract is incomplete")
    return {name: data[name] for name in FIELDS}


def restic_environment(data):
    if not data["S3_ENDPOINT"].startswith("https://"):
        raise ValueError("Storage endpoint must use HTTPS")
    # Do not inherit competing Restic destinations, passwords, AWS profiles or session tokens.
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "RESTIC_REPOSITORY": "s3:"
        + data["S3_ENDPOINT"].rstrip("/")
        + "/"
        + data["S3_BUCKET"]
        + "/cliproxy-fleet/restic",
        "RESTIC_PASSWORD": data["CLIPROXY_FLEET_RESTIC_PASSWORD"],
        "AWS_ACCESS_KEY_ID": data["S3_ACCESS_KEY_ID"],
        "AWS_SECRET_ACCESS_KEY": data["S3_SECRET_ACCESS_KEY"],
        "AWS_DEFAULT_REGION": data["S3_REGION"],
    }


def client(data):
    environment = restic_environment(data)

    def run(*args):
        if not args or args[0] not in ("snapshots", "dump", "restore"):
            raise ValueError("Only read-only cloud operations are permitted")
        return subprocess.run(
            ["restic", "-o", "s3.bucket-lookup=path", "--no-cache", "--no-lock", *args],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        ).stdout

    return run


def latest(restic):
    snapshots = json.loads(
        restic(
            "snapshots",
            "--json",
            "--host",
            "cliproxy-primary",
            "--tag",
            "cliproxy-checkpoint-v1",
        )
    )
    if not snapshots:
        raise ValueError("No cloud checkpoint")
    snapshot = max(snapshots, key=lambda value: timestamp(value["time"]))
    if not re.fullmatch(r"[0-9a-f]{64}", snapshot["id"]):
        raise ValueError("Invalid checkpoint identifier")
    paths = snapshot["paths"]
    if (
        len(paths) != 1
        or not pathlib.PurePosixPath(paths[0]).is_absolute()
        or ".." in pathlib.PurePosixPath(paths[0]).parts
    ):
        raise ValueError("Invalid checkpoint path")
    return snapshot


def timestamp(value):
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return parsed


def fresh(value, seconds, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    age = (now - timestamp(value)).total_seconds()
    if not -300 <= age <= seconds:
        raise ValueError("Cloud status is stale or future-dated")


def client_key(token):
    """Read only the client API key; independent of the backup fields in settings()."""
    status, body = request(shared_url(), {"X-Vault-Token": token})
    if status != 200:
        raise ValueError("Vault read failed")
    value = json.loads(body)["data"]["data"].get("CLIPROXY_FLEET_CLIENT_API_KEY")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Vault has no client API key")
    return value.strip()
