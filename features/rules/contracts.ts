import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentGuide } from '../../src/cli/agent-guide';
import {
  checkIdsIn,
  checkRegistry,
  renderCheckRegistry,
  type CheckRegistry,
  type RegisteredCheck,
} from '../../src/check-registry';
import { checkOwner } from '../../src/check-owners';
import { executeFleet } from '../../src/cli/fleet';
import { fleetReport } from '../../src/cli/fleet-report';
import { fleetState } from '../../src/cli/fleet-state';
import { managerSchedule } from '../../src/cli/fleet-sync-schedule';
import type { Platform } from '../../src/platform/types';
import { execute } from '../../src/cli/program';
import { fleet } from '../../src/fleet-config';
import { managerFailure } from '../../src/manager-failure';
import { appendRun } from '../../src/state/history';
import { Commands, failed, succeeded } from '../support/commands';
import type { DataTable } from '../support/gherkin';
import { validate } from '../support/json-schema';
import { rules } from './steps';

const { Given, When, Then } = rules;
const root = resolve(import.meta.dir, '../..');

/** What these steps keep between them, per scenario. */
const outputs = new WeakMap<object, unknown>();
const output = (world: object): unknown => outputs.get(world);

// ── Command output ───────────────────────────────────────────────────────

When('fleet-sync stops before it reaches a machine', (world) => {
  outputs.set(
    world,
    managerFailure(fleet, 'a'.repeat(40), 'FLEET_FIXTURE', 'Fixture remedy.')
  );
});

When(
  'fleet-status checks this manager only, where every command succeeds',
  async (world) => {
    const commands = new Commands();
    commands.answer(() => true, succeeded());
    const outcome = await executeFleet(
      'doctor',
      { local: true, require: 'none' },
      { workspace: root, config: '/no-roster' },
      { run: commands.run, source: () => Promise.resolve('') }
    );
    outputs.set(world, outcome.data);
  }
);

When(
  'fleet-repair previews the repairs of this manager only, where every command succeeds',
  async (world) => {
    const commands = new Commands();
    commands.answer(() => true, succeeded());
    const outcome = await executeFleet(
      'repair',
      { local: true, require: 'none' },
      { workspace: root, config: '/no-roster' },
      { run: commands.run, source: () => Promise.resolve('') }
    );
    outputs.set(world, outcome.data);
  }
);

/** An empty fleet state of this scenario's own, removed afterwards. */
function emptyState(world: { defer(undo: () => void): void }): string {
  const state = mkdtempSync(join(tmpdir(), 'contract-state-'));
  const before = process.env['DEVFLEET_STATE'];
  process.env['DEVFLEET_STATE'] = state;
  world.defer(() => {
    process.env['DEVFLEET_STATE'] = before;
    rmSync(state, { recursive: true, force: true });
  });
  return state;
}

When(
  'fleet-state checks a fleet state whose bucket cannot be reached',
  async (world) => {
    const state = emptyState(world);
    const commands = new Commands();
    commands.answer(() => true, failed('unreachable'));
    const outcome = await fleetState(
      { json: true },
      {
        run: commands.run,
        env: { DEVFLEET_STATE: state, HOME: state },
        home: state,
        ask: null,
      }
    );
    outputs.set(world, outcome.data);
  }
);

When('fleet-state prints the example configuration', async (world) => {
  outputs.set(world, (await fleetState({ example: true, json: true })).data);
});

When(
  /^the manager schedule is asked to (report its status|pause, without authorization)$/,
  async (world, action: string) => {
    emptyState(world);
    const outcome = await managerSchedule(
      {
        action: action === 'report its status' ? 'status' : 'pause',
        revision: 'a'.repeat(40),
        config: '/no-roster',
        authorized: false,
      },
      new Commands().run,
      {
        scheduledJobStatus: () => ({ installed: false, supported: true }),
      } as unknown as Platform
    );
    outputs.set(world, outcome.data);
  }
);

When('fleet-report reads a history of two runs', (world) => {
  emptyState(world);
  const now = new Date('2026-11-01T12:00:00Z');
  for (const [finished, ok] of [
    ['2026-11-01T10:00:00Z', false],
    ['2026-11-01T11:00:00Z', true],
  ] as const)
    appendRun(
      {
        startedAt: finished,
        finishedAt: finished,
        durationMs: 1000,
        trigger: 'operator',
        revision: null,
        ok,
        exitCode: ok ? 0 : 1,
        failing: ok ? [] : ['ssh:timeout'],
        notReady: ok ? [] : ['worker-one'],
      },
      process.env,
      now
    );
  outputs.set(world, fleetReport({ since: '1d' }, process.env, now).data);
});

When('a command is refused as a usage error', async (world) => {
  const outcome = await execute(
    ['fleet-status', '--apply', '--yes', '--json'],
    { workspace: root, config: '/no-roster' },
    { version: 'test', releasedAt: null }
  );
  outputs.set(world, outcome.data);
});

Given('a fleet-sync report that says it is version 1', (world) => {
  outputs.set(world, {
    ...managerFailure(fleet, null, 'FLEET_FIXTURE', 'Fixture remedy.'),
    version: 1,
  });
});

Then('what it prints matches {string}', (world, schema: string) => {
  expect(validate(resolve(root, schema), output(world))).toEqual([]);
});

Then('it does not match {string}', (world, schema: string) => {
  expect(validate(resolve(root, schema), output(world))).not.toEqual([]);
});

// ── Check IDs ────────────────────────────────────────────────────────────

const registries = new WeakMap<object, CheckRegistry>();
const registry = (world: object): CheckRegistry => {
  let found = registries.get(world);
  if (!found) {
    found = checkRegistry();
    registries.set(world, found);
  }
  return found;
};
const published = (world: object): RegisteredCheck[] =>
  (output(world) as { checks: RegisteredCheck[] }).checks;
const written = new WeakMap<object, string[]>();

When('schema\\/check-ids.json is read', (world) => {
  outputs.set(
    world,
    JSON.parse(readFileSync(resolve(root, 'schema/check-ids.json'), 'utf8'))
  );
});

Then('it is the registry the code generates', (world) => {
  const generated = renderCheckRegistry();
  if (process.env['DEVFLEET_UPDATE_DOCS'])
    writeFileSync(resolve(root, 'schema/check-ids.json'), generated);
  else expect(output(world)).toEqual(JSON.parse(generated));
  expect(readFileSync(resolve(root, 'schema/check-ids.json'), 'utf8')).toBe(
    generated
  );
});

When('the registry is generated from the code', (world) => {
  registry(world);
});

Then('every check ID the code reports has a meaning', (world) => {
  expect(registry(world).missing).toEqual([]);
  for (const entry of registry(world).checks)
    expect(entry.meaning.length).toBeGreaterThan(10);
});

Then('no meaning is left without a check', (world) => {
  expect(registry(world).unused).toEqual([]);
});

Then('every check has an owner in src\\/check-owners.ts', (world) => {
  expect(
    registry(world)
      .checks.filter((entry) => !checkOwner(entry.id))
      .map((entry) => entry.id)
  ).toEqual([]);
});

When(
  'the check IDs written in this source are listed:',
  (world, source: string) => {
    written.set(world, checkIdsIn(source));
  }
);

When(
  'the check IDs written in this shell script are listed:',
  (world, source: string) => {
    written.set(world, checkIdsIn(source, true));
  }
);

Then('they are {string}', (world, ids: string) => {
  expect(written.get(world)).toEqual(ids.split(',').filter(Boolean));
});

Then(
  /^it lists "([^"]+)" as (required|advisory), repaired by "([^"]+)"$/,
  (world, id: string, severity: string, repair: string) => {
    const entry = published(world).find((check) => check.id === id);
    expect(entry?.severity).toBe(severity as RegisteredCheck['severity']);
    if (repair === 'a person')
      expect(
        (entry?.repair as { manual?: string }).manual?.length
      ).toBeGreaterThan(20);
    else expect(entry?.repair).toEqual({ recipe: repair });
  }
);

Then('it lists each of:', (world, table: DataTable) => {
  const ids = published(world).map((check) => check.id);
  for (const id of table.list()) expect(ids).toContain(id);
});

Then(
  'the only names left as {string} are the ones taken at run time:',
  (world, star: string, table: DataTable) => {
    expect(
      published(world)
        .map((check) => check.id)
        .filter((id) => id.includes(star))
    ).toEqual(table.list());
  }
);

/** The function around a place in a source: from the closing brace before
 * it to the one after, at the start of a line. */
function around(text: string, at: number): string {
  const start = text.lastIndexOf('\n}', at);
  const end = text.indexOf('\n}', at);
  return text.slice(start < 0 ? 0 : start, end < 0 ? text.length : end);
}

Then(
  'every advisory check the code writes by name fails only where it says it is not required',
  async (world) => {
    const advisory = published(world)
      .filter((check) => check.severity === 'advisory')
      .map((check) => check.id);
    const counting: string[] = [];
    for await (const path of new Bun.Glob('src/**/*.ts').scan(root)) {
      if (
        path.endsWith('check-owners.ts') ||
        path.endsWith('check-registry.ts')
      )
        continue;
      const text = readFileSync(resolve(root, path), 'utf8');
      for (const id of advisory)
        for (
          let at = text.indexOf(`'${id}'`);
          at >= 0;
          at = text.indexOf(`'${id}'`, at + 1)
        ) {
          const body = around(text, at);
          if (/'fail'/.test(body) && !/required: false/.test(body))
            counting.push(`${id} in ${path}`);
        }
    }
    expect(counting).toEqual([]);
  }
);

// ── The agent guide ──────────────────────────────────────────────────────

Then('the agent guide names, for its output:', (_world, table: DataTable) => {
  const guide = JSON.stringify(
    agentGuide({ version: 'test', releasedAt: null }).output
  );
  for (const text of table.list()) expect(guide).toContain(text);
});

Then('the agent guide does not say every report is version 1', () => {
  const { output: described } = agentGuide({
    version: 'test',
    releasedAt: null,
  });
  expect(JSON.stringify(described)).not.toContain('{version:1,command,ok');
});

Then('it matches {string}', (world, schema: string) => {
  expect(validate(resolve(root, schema), output(world))).toEqual([]);
});
