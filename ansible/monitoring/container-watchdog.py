#!/usr/bin/python3
"""Restart a fleet container that stays unhealthy, a bounded number of times.

Managed by fleet-sync (ansible/monitoring/hub-darwin.yml) as the per-user
launchd agent dev.devfleet.container-watchdog on the manager. Docker restarts
a container that exits, never one that hangs while it still holds its port.
Every run reads the health of each container labelled
dev.devfleet.watchdog=restart. One that was unhealthy for --unhealthy-checks
runs in a row is restarted, at most --max-restarts-per-hour times an hour.
Past that cap it is left alone and recorded as capped: a restart storm is a
failing check (manager:container-watchdog), not a loop.

Every decision is one JSON line on stdout; nothing a container printed is
repeated. The state file holds counters only and is safe to delete.

Usage: container-watchdog.py --state FILE [--unhealthy-checks N]
                             [--max-restarts-per-hour N] [--dry-run]
"""
import argparse
import json
import os
import subprocess
import sys
import time

HOUR = 3600
LABEL = 'dev.devfleet.watchdog=restart'


def log(**event):
    print(json.dumps(event, sort_keys=True), flush=True)


def decide(memory, health, now, limit, cap):
    """The next memory, and the containers to restart now with the reason.

    memory: {name: {"unhealthy": n, "restarts": [t, ...], "capped": t|None}}
    health: {name: "healthy" | "unhealthy" | "starting" | "none"}
    """
    after, restart = {}, []
    for name, status in sorted(health.items()):
        before = memory.get(name, {})
        restarts = [t for t in before.get('restarts', []) if now - t < HOUR]
        unhealthy = before.get('unhealthy', 0) + 1 if status == 'unhealthy' else 0
        capped = before.get('capped')
        if capped is not None and now - capped >= HOUR:
            capped = None
        if unhealthy >= limit:
            if len(restarts) < cap:
                restarts.append(now)
                restart.append((name, f'unhealthy for {unhealthy} checks'))
                unhealthy = 0
            else:
                capped = now
        after[name] = {'unhealthy': unhealthy, 'restarts': restarts,
                       'capped': capped}
    return after, restart


def docker(*args):
    return subprocess.run(['docker', *args], capture_output=True, text=True,
                          timeout=60)


def observe():
    listed = docker('ps', '--filter', f'label={LABEL}', '--format', '{{.Names}}')
    if listed.returncode:
        return None
    health = {}
    for name in listed.stdout.split():
        state = docker('inspect', '--format',
                       '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
                       name)
        health[name] = state.stdout.strip() if state.returncode == 0 else 'none'
    return health


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--unhealthy-checks', type=int, default=3)
    parser.add_argument('--max-restarts-per-hour', type=int, default=3)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        with open(args.state) as file:
            memory = json.load(file)
        if not isinstance(memory, dict):
            memory = {}
    except (OSError, ValueError):
        memory = {}
    health = observe()
    if health is None:
        log(event='docker_unavailable')
        return 0
    now = time.time()
    memory, restart = decide(memory, health, now, args.unhealthy_checks,
                             args.max_restarts_per_hour)
    for name, reason in restart:
        ok = True
        if not args.dry_run:
            ok = docker('restart', name).returncode == 0
        log(event='restarted', container=name, reason=reason, ok=ok,
            dry_run=args.dry_run)
    for name, entry in memory.items():
        if entry['capped'] == now:
            log(event='capped', container=name,
                restarts=len(entry['restarts']))
    os.makedirs(os.path.dirname(os.path.abspath(args.state)), exist_ok=True)
    temporary = args.state + '.tmp'
    with open(temporary, 'w') as file:
        json.dump(memory, file, sort_keys=True)
    os.replace(temporary, args.state)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
