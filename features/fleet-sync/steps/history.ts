import { expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fleetReport } from '../../../src/cli/fleet-report';
import { FleetUsageError } from '../../../src/errors';
import { capScheduleLogs } from '../../../src/cli/schedule-logs';
import { scheduleCheck } from '../../../src/schedule-check';
import {
  appendRun,
  readHistory,
  recordSchedule,
  summarizeRun,
  type SyncRun,
} from '../../../src/state/history';
import type { DataTable } from '../../support/gherkin';
import {
  fleetSync,
  setEnv,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What only these steps keep between them. */
interface Kept {
  logs: string | undefined;
  check: ReturnType<typeof scheduleCheck> | undefined;
}
const states = new WeakMap<FleetSyncWorld, Kept>();

function state(world: FleetSyncWorld): Kept {
  let found = states.get(world);
  if (!found) {
    found = { logs: undefined, check: undefined };
    states.set(world, found);
  }
  return found;
}

function list(cell: string | undefined): string[] {
  return (cell ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A row of a history table as the history keeps it. */
function runFrom(row: Record<string, string>): SyncRun {
  const finished = Date.parse(row['finished']!);
  const durationMs = Number(row['seconds'] ?? '60') * 1000;
  const ok = row['ok'] === 'yes';
  return {
    startedAt: new Date(finished - durationMs).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs,
    trigger: row['trigger'] === 'schedule' ? 'schedule' : 'operator',
    revision: 'a'.repeat(40),
    ok,
    exitCode: ok ? 0 : 1,
    failing: list(row['failing']),
    notReady: list(row['not ready']),
  };
}

// ── The history in the fleet state ───────────────────────────────────────

Given('a fleet state of its own, holding no history', (world) => {
  setEnv(world, 'DEVFLEET_STATE', temporary(world, 'fleet-history-'));
});

Given('fleet-sync recorded these runs:', (_world, table: DataTable) => {
  for (const row of table.hashes())
    appendRun(runFrom(row), process.env, new Date(row['finished']!));
});

Given(
  'fleet-sync recorded {int} runs, one a minute, the last at {string}',
  (_world, count: number, last: string) => {
    for (let index = count - 1; index >= 0; index -= 1) {
      const finished = new Date(Date.parse(last) - index * 60_000);
      appendRun(
        runFrom({ finished: finished.toISOString(), ok: 'yes' }),
        process.env,
        finished
      );
    }
  }
);

Given(
  /^the schedule was turned (on|off) at "([^"]*)", every (\d+) minutes$/,
  (_world, on: string, at: string, minutes: string) => {
    recordSchedule({
      enabled: on === 'on',
      intervalSeconds: Number(minutes) * 60,
      changedAt: at,
    });
  }
);

When(
  'fleet-sync records the run of {string} to {string} that ended with {int} and reported:',
  (_world, started: string, finished: string, exitCode: number, report) => {
    appendRun(
      summarizeRun(
        JSON.parse(String(report)),
        { startedAt: new Date(started), finishedAt: new Date(finished) },
        'schedule',
        exitCode
      ),
      process.env,
      new Date(finished)
    );
  }
);

When(
  'fleet-sync records a run that finished at {string}',
  (_world, finished: string) => {
    appendRun(
      runFrom({ finished, ok: 'yes' }),
      process.env,
      new Date(finished)
    );
  }
);

Then('the history holds this run:', (_world, table: DataTable) => {
  const runs = readHistory().runs;
  expect(runs).toHaveLength(1);
  const expected = table.rowsHash();
  const run = runs[0]!;
  expect({
    trigger: run.trigger,
    ok: String(run.ok),
    exitCode: String(run.exitCode),
    durationMs: String(run.durationMs),
    revision: String(run.revision),
    failing: run.failing.join(', '),
    'not ready': run.notReady.join(', '),
  }).toEqual(expected as never);
});

Then('the history holds {int} runs', (_world, count: number) => {
  expect(readHistory().runs).toHaveLength(count);
});

Then(
  'the oldest run in the history finished at {string}',
  (_world, finished: string) => {
    expect(readHistory().runs[0]?.finishedAt).toBe(
      new Date(finished).toISOString()
    );
  }
);

// ── fleet-report ─────────────────────────────────────────────────────────

When(
  'the operator asks for the fleet report since {string}, at {string}',
  (world, since: string, now: string) => {
    world.outcome = fleetReport({ since }, process.env, new Date(now));
  }
);

When(
  'the operator asks for the fleet report since {string}',
  (world, since: string) => {
    try {
      world.outcome = fleetReport({ since });
    } catch (error) {
      world.failure = error as Error;
    }
  }
);

Then('the fleet report lists {int} runs', (world, count: number) => {
  const data = world.outcome?.data as { entries: unknown[]; runs: number };
  expect(data.entries).toHaveLength(count);
  expect(data.runs).toBe(count);
});

Then(
  'the most frequent failing checks are, in order:',
  (world, table: DataTable) => {
    const data = world.outcome?.data as {
      failingChecks: { id: string; runs: number }[];
    };
    expect(
      data.failingChecks.map((check) => [check.id, String(check.runs)])
    ).toEqual(table.raw());
  }
);

Then(
  'the time each machine was not ready is, in minutes:',
  (world, table: DataTable) => {
    const data = world.outcome?.data as {
      notReady: { node: string; ms: number }[];
    };
    expect(
      data.notReady.map((node) => [node.node, String(node.ms / 60_000)])
    ).toEqual(table.raw());
  }
);

Then('the request is refused as a usage error', (world) => {
  expect(world.failure).toBeInstanceOf(FleetUsageError);
});

// ── The schedule's check and logs ────────────────────────────────────────

When('the schedule is checked at {string}', (world, now: string) => {
  state(world).check = scheduleCheck(readHistory(), new Date(now));
});

Then(
  /^the check "manager:schedule" (passes|fails)$/,
  (world, outcome: string) => {
    expect(state(world).check?.id).toBe('manager:schedule');
    expect(state(world).check?.status).toBe(
      outcome === 'passes' ? 'pass' : 'fail'
    );
  }
);

Then('there is no schedule check', (world) => {
  expect(state(world).check).toBeNull();
});

Given(
  /^the schedule's log "([^"]*)" holds (\d+) KiB of lines$/,
  (world, name: string, kib: string) => {
    const directory = (state(world).logs ??= temporary(world, 'fleet-logs-'));
    mkdirSync(directory, { recursive: true });
    const line = `${'x'.repeat(63)}\n`;
    writeFileSync(join(directory, name), line.repeat(Number(kib) * 16));
  }
);

When(
  'a scheduled run starts, with logs capped at {int} KiB',
  (world, kib: number) => {
    capScheduleLogs(state(world).logs!, kib * 1024);
  }
);

Then(
  /^the log "([^"]*)" holds at most (\d+) KiB, and ends with a whole line$/,
  (world, name: string, kib: string) => {
    const path = join(state(world).logs!, name);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(Number(kib) * 1024);
    expect(readFileSync(path, 'utf8')).toMatch(/^x+\n(x+\n)*$/);
  }
);

Then(
  /^the log "([^"]*)" still holds (\d+) KiB$/,
  (world, name: string, kib: string) => {
    expect(statSync(join(state(world).logs!, name)).size).toBe(
      Number(kib) * 1024
    );
  }
);
