"""Say whether the worker's T3 runs an agent turn: exit 0 when it runs none,
1 when it runs one and 2 when it cannot tell.

T3 offers no command that lists the running turns of every project, so this
reads the runs T3 records in its own state database, read-only. Anything it
cannot read counts as busy: a restart never ends a turn on a guess.

With --activity it prints one JSON line for fleet-status instead and exits 0:
how many agent turns are under way and when the last one was requested or
ended. Only the status and the times of a run are read, never its content.

Usage: t3-idle.py --state ~/.t3/userdata/statev2.sqlite [--activity]
"""
import argparse
import json
import sqlite3
import sys

IDLE, BUSY, UNKNOWN = 0, 1, 2

# The statuses of a turn that has not ended yet.
UNDER_WAY = ('queued', 'preparing', 'starting', 'running', 'waiting')


def connect(state):
    return sqlite3.connect(f'file:{state}?mode=ro', uri=True, timeout=5)


def running_turns(state):
    connection = connect(state)
    try:
        (count,) = connection.execute(
            "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status = 'running'"
        ).fetchone()
        return count
    finally:
        connection.close()


def activity(state):
    connection = connect(state)
    try:
        marks = ','.join('?' for _ in UNDER_WAY)
        (under_way,) = connection.execute(
            f'SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ({marks})',
            UNDER_WAY,
        ).fetchone()
        (last,) = connection.execute(
            'SELECT max(coalesce(completed_at, requested_at)) FROM orchestration_v2_projection_runs'
        ).fetchone()
        return {'version': 1, 'running': under_way, 'lastActivity': last}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--activity', action='store_true')
    args = parser.parse_args()
    if args.activity:
        try:
            print(json.dumps(activity(args.state)))
        except sqlite3.Error:
            print(json.dumps({'version': 1, 'unknown': True}))
        return 0
    try:
        count = running_turns(args.state)
    except sqlite3.Error:
        print('T3_IDLE_UNKNOWN')
        return UNKNOWN
    print(f'{count} running turn(s)')
    return BUSY if count else IDLE


if __name__ == '__main__':
    sys.exit(main())
