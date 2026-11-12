"""Say whether the worker's T3 runs an agent turn: exit 0 when it runs none,
1 when it runs one and 2 when it cannot tell.

T3 offers no command that lists the running turns of every project, so this
reads the runs T3 records in its own state database, read-only. Anything it
cannot read counts as busy: a restart never ends a turn on a guess.

Usage: t3-idle.py --state ~/.t3/userdata/statev2.sqlite
"""
import argparse
import sqlite3
import sys

IDLE, BUSY, UNKNOWN = 0, 1, 2


def running_turns(state):
    connection = sqlite3.connect(f'file:{state}?mode=ro', uri=True, timeout=5)
    try:
        (count,) = connection.execute(
            "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status = 'running'"
        ).fetchone()
        return count
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    args = parser.parse_args()
    try:
        count = running_turns(args.state)
    except sqlite3.Error:
        print('T3_IDLE_UNKNOWN')
        return UNKNOWN
    print(f'{count} running turn(s)')
    return BUSY if count else IDLE


if __name__ == '__main__':
    sys.exit(main())
