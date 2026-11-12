import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetReport } from '../../../src/cli/fleet-report';
import { FleetUsageError } from '../../../src/errors';
import { parse } from 'yaml';
import macos from '../../../ansible/macos/policy.json';
import { parseDefinition } from '../../../src/definition';
import { reloadFleet } from '../../../src/fleet-config';
import {
  jobLogs,
  managerJobLogs,
  newsyslogDropIn,
} from '../../../src/manager-health';
import type { Check } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
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
  ROOT,
  fleetSync,
  setEnv,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What only these steps keep between them. */
interface Kept {
  /** The manager's home, for the logs of its scheduled jobs. */
  logs: string | undefined;
  check: Check | null | undefined;
  /** The newsyslog drop-in installed on the manager, when there is one. */
  dropIn?: string;
  /** The drop-in the grant installs, rendered for one user. */
  newsyslog?: { content: string; validate: string };
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
  /^the check "([^"]+)" (passes|fails)$/,
  (world, id: string, outcome: string) => {
    expect(state(world).check?.id).toBe(id);
    expect(state(world).check?.status).toBe(
      outcome === 'passes' ? 'pass' : 'fail'
    );
  }
);

Then(
  'the check {string} warns with {string}',
  (world, id: string, summary: string) => {
    expect(state(world).check?.id).toBe(id);
    expect(state(world).check?.status).toBe('warn');
    expect(state(world).check?.summary).toBe(summary);
  }
);

Then(
  'the remedy of the check {string} names {string}',
  (world, id: string, text: string) => {
    expect(state(world).check?.id).toBe(id);
    expect(state(world).check?.remedy?.action).toContain(text);
  }
);

Then('there is no schedule check', (world) => {
  expect(state(world).check).toBeNull();
});

// ── How often the schedule runs ──────────────────────────────────────────

/** The example fleet, with the manager's schedule set as the scenario says. */
function exampleWith(schedule: unknown): Record<string, unknown> {
  const example = JSON.parse(
    readFileSync(join(ROOT, 'examples/fleet.json'), 'utf8')
  ) as { manager: Record<string, unknown> } & Record<string, unknown>;
  const { state: _bucket, ...rest } = example;
  return { ...rest, manager: { ...example.manager, schedule } };
}

Given(
  "the fleet configuration sets the manager's schedule to:",
  (world, text: string) => {
    const path = join(temporary(world, 'fleet-schedule-'), 'fleet.json');
    writeFileSync(path, JSON.stringify(exampleWith(JSON.parse(text))));
    setEnv(world, 'DEVFLEET_CONFIG', path);
    reloadFleet();
    world.defer(reloadFleet);
  }
);

When(
  /^a fleet configuration that sets the manager's schedule to (.+) is read$/,
  (world, schedule: string) => {
    try {
      parseDefinition(exampleWith(JSON.parse(schedule)));
    } catch (error) {
      world.failure = error as Error;
    }
  }
);

Then('reading it fails at {string}', (world, path: string) => {
  expect(world.failure).toBeInstanceOf(Error);
  expect((world.failure as Error).message).toContain(path);
});

// ── The logs of the scheduled jobs ───────────────────────────────────────

const USER = 'dev';

/** The manager's home, the drop-in installed there, and what reads it. */
function logState(world: FleetSyncWorld): Kept {
  state(world).logs ??= temporary(world, 'fleet-home-');
  return state(world);
}

Given(
  "the newsyslog drop-in for the manager's job logs is installed",
  (world) => {
    const home = logState(world).logs!;
    logState(world).dropIn = [
      '# Managed by dev-fleet: manager job logs',
      ...jobLogs(home).map((log) => `${log} ${USER}:staff 600 3 1024 * NZ`),
      '',
    ].join('\n');
  }
);

Given(
  /^the job log "([^"]*)" holds (\d+) KiB of lines$/,
  (world, name: string, kib: string) => {
    const directory = join(logState(world).logs!, macos.jobLogs.directory);
    mkdirSync(directory, { recursive: true });
    const line = `${'x'.repeat(63)}\n`;
    writeFileSync(join(directory, name), line.repeat(Number(kib) * 16));
  }
);

When("the manager's job logs are checked", async (world) => {
  const kept = logState(world);
  // Only the drop-in is read through a command; nothing else may run.
  const read = (command: string[]) =>
    Promise.resolve(
      command[0] === 'cat' &&
        command[1] === newsyslogDropIn(USER) &&
        kept.dropIn !== undefined
        ? succeeded(kept.dropIn)
        : failed()
    );
  kept.check = await managerJobLogs(read, kept.logs!, USER);
});

When(
  'the newsyslog drop-in of {string} is read for the user {string}',
  (world, playbook: string, user: string) => {
    const plays = parse(readFileSync(join(ROOT, playbook), 'utf8')) as {
      tasks?: Record<string, unknown>[];
    }[];
    const task = plays
      .flatMap((play) => play.tasks ?? [])
      .map(
        (entry) =>
          entry['ansible.builtin.copy'] as Record<string, string> | undefined
      )
      .find((copy) => copy?.['dest']?.startsWith('/etc/newsyslog.d/'));
    expect(task).toBeDefined();
    // The playbook's variables, as an administrator's run gives them.
    const values: Record<string, string> = {
      user,
      job_log_directory: `/Users/${user}/${macos.jobLogs.directory}`,
      'manager_group.stdout': 'staff',
      'fleetSync.label': macos.fleetSync.label,
      'fleetWatch.label': macos.fleetWatch.label,
      'jobLogs.keep': String(macos.jobLogs.keep),
      'jobLogs.maxKiB': String(macos.jobLogs.maxKiB),
    };
    const render = (text: string) =>
      text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
        expect(values[name]).toBeDefined();
        return values[name]!;
      });
    logState(world).newsyslog = {
      content: render(task!['content']!),
      validate: task!['validate'] ?? '',
    };
  }
);

Then(
  /^it rotates exactly these logs under "([^"]+)", at (\d+) KiB, keeping (\d+):$/,
  (world, directory: string, kib: string, keep: string, table: DataTable) => {
    const entries = logState(world)
      .newsyslog!.content.split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.split(/\s+/));
    expect(entries.map((fields) => fields[0])).toEqual(
      table.list().map((name) => `${directory}/${name}`)
    );
    for (const fields of entries) {
      expect(fields[1]).toBe(`${USER}:staff`);
      expect(fields[3]).toBe(String(keep));
      expect(fields[4]).toBe(String(kib));
      // No process to signal: launchd opens the log again for every run.
      expect(fields[6]).toContain('N');
    }
  }
);

Then('it is checked with newsyslog before it is installed', (world) => {
  expect(logState(world).newsyslog!.validate).toBe(
    '/usr/sbin/newsyslog -n -f %s'
  );
});
