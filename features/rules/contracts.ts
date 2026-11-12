import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentGuide } from '../../src/cli/agent-guide';
import { executeFleet } from '../../src/cli/fleet';
import { fleetReport } from '../../src/cli/fleet-report';
import { execute } from '../../src/cli/program';
import { fleet } from '../../src/fleet-config';
import { managerFailure } from '../../src/manager-failure';
import { appendRun } from '../../src/state/history';
import { Commands, succeeded } from '../support/commands';
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

When('fleet-report reads a history of two runs', (world) => {
  const state = mkdtempSync(join(tmpdir(), 'contract-history-'));
  const before = process.env['DEVFLEET_STATE'];
  process.env['DEVFLEET_STATE'] = state;
  world.defer(() => {
    process.env['DEVFLEET_STATE'] = before;
    rmSync(state, { recursive: true, force: true });
  });
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

interface Registered {
  id: string;
  meaning: string;
}
const registry = (): Registered[] =>
  (
    JSON.parse(
      readFileSync(resolve(root, 'schema/check-ids.json'), 'utf8')
    ) as {
      checks: Registered[];
    }
  ).checks;

/** Every check ID written in the code: an `id:` of a check, the phase an
 * `attempt` names, and the bootstrap's phases. A name filled in at run time
 * is a `*`.
 */
async function reported(): Promise<Set<string>> {
  const found = new Set<string>(['bootstrap:*']);
  const pattern =
    /\bid: (?:'([a-z0-9-]+:[^']+)'|"([a-z0-9-]+:[^"]+)"|`([a-z0-9-]+:[^`]+)`)|\battempt\(\s*'([a-z0-9-]+:[^']+)'|\bid: [^,\n]*\?\? '([a-z0-9-]+:[^']+)'/g;
  for (const directory of ['src', 'bootstrap', 'agents'])
    for await (const path of new Bun.Glob(`${directory}/**/*.ts`).scan(root))
      for (const match of readFileSync(resolve(root, path), 'utf8').matchAll(
        pattern
      ))
        found.add(
          match
            .slice(1)
            .find(Boolean)!
            .replace(/\$\{[^}]*\}+/g, '*')
        );
  return found;
}

Then(
  'every check ID the code reports is in the check-ID registry',
  async () => {
    const known = new Set(registry().map((entry) => entry.id));
    expect([...(await reported())].filter((id) => !known.has(id))).toEqual([]);
  }
);

Then('the registry names no check the code no longer reports', async () => {
  const code = await reported();
  // state:* is named by the document it checks (fleet-state).
  expect(
    registry()
      .map((entry) => entry.id)
      .filter((id) => !code.has(id) && id !== 'state:*')
  ).toEqual([]);
});

Then('every entry of the registry says what it means', () => {
  for (const entry of registry())
    expect(entry.meaning.length).toBeGreaterThan(10);
});

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
