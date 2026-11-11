#!/usr/bin/env python3
"""Off-machine, read-only checks using short-lived GitHub OIDC Vault access."""

import sys

sys.dont_write_bytecode = True

import json
import os
import pathlib
import time
import cloud_state
import fleet_config


def endpoint_health(endpoint, key, request=cloud_state.request):
    def get(path, authenticated=False):
        return request(
            endpoint + path,
            {"Authorization": "Bearer " + key} if authenticated else None,
        )

    if get("/v1/models")[0] != 401:
        raise ValueError("Anonymous inference must be rejected")
    status, body = get("/v1/models", True)
    models = json.loads(body).get("data") if status == 200 else None
    if not isinstance(models, list) or not models:
        raise ValueError("Authenticated endpoint has no available models")
    # Upstream counts missing/wrong management keys toward a per-IP ban.
    # Scheduled health checks must never generate those failed login attempts.
    if get("/management.html")[0] != 200:
        raise ValueError("Dashboard unavailable")


def cloud_health(restic):
    snapshot = cloud_state.latest(restic)
    cloud_state.fresh(snapshot["time"], 45 * 60)
    path = snapshot["paths"][0].rstrip("/") + "/state/status/gc-success.json"
    gc = json.loads(restic("dump", snapshot["id"], path))
    cloud_state.fresh(gc["time"], 9 * 86400)
    return snapshot["id"]


def main():
    token = os.environ.get("VAULT_TOKEN", "")
    if not token:
        raise ValueError("Existing short-lived Vault login required")
    data = cloud_state.settings(token)
    errors = []
    for attempt in range(3):
        try:
            endpoint_health(fleet_config.endpoint(), data["CLIPROXY_FLEET_CLIENT_API_KEY"])
            print("PASS: external HTTPS, client authentication, models and dashboard.")
            break
        except Exception:
            if attempt == 2:
                errors.append("Public endpoint authentication/availability failed.")
            else:
                time.sleep(10)
    try:
        cloud_health(cloud_state.client(data))
        print(
            "PASS: cloud checkpoint under 45 minutes old; successful GC under nine days old."
        )
    except Exception:
        errors.append("Cloud checkpoint or GC freshness/readability failed.")
    if errors:
        for error in errors:
            print("FAIL:", error)
        raise ValueError(" ".join(errors))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(
            "External CLI proxy verification failed; credentials and upstream responses suppressed. See the last completed check above."
        ) from None
