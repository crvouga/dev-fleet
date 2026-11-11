"""Vault API helpers. Never print response bodies, tokens, or credentials."""

import sys

sys.dont_write_bytecode = True

import pathlib as _pathlib

sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
import cliproxy_host
import fleet_config


import json, pathlib, urllib.request, os

ROOT = cliproxy_host.default_root().resolve()


def request(path, token=None, data=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Vault-Token"] = token
    req = urllib.request.Request(
        fleet_config.vault()["address"] + "/v1/" + path,
        headers=headers,
        data=json.dumps(data).encode() if data is not None else None,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def token():
    return (ROOT / "state/secrets/vault-token").read_text().strip()


def credentials():
    data = request(fleet_config.vault()["shared"], token())["data"]["data"]
    fields = [
        "S3_ENDPOINT",
        "S3_REGION",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
    ]
    if any(not data.get(k) for k in fields):
        raise ValueError("Missing S3 field")
    return {k: data[k] for k in fields}


def renew():
    t = token()
    meta = request("auth/token/lookup-self", t)["data"]
    if meta.get("ttl", 0) < 3600:
        if not meta.get("renewable"):
            raise ValueError("Token expiry requires login")
        request("auth/token/renew-self", t, {})
    return meta.get("ttl", 0)
