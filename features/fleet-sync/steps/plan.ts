import { expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  planText,
  syncPlan,
  type SyncPlan,
} from '../../../src/cli/fleet-sync-plan';
import { selected } from '../../../src/cli/fleet-sync-remote';
import { PLATFORM_PROBE } from '../../../src/machine/platform';
import { failed, succeeded } from '../../support/commands';
import example from '../../../examples/fleet.json';
import type { DataTable } from '../../support/gherkin';
import {
  fleetSync,
  request,
  rosterEntry,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

const plans = new WeakMap<FleetSyncWorld, SyncPlan>();

/** The fleet configuration last applied, and the one to apply: the example,
 * with the features a scenario gives a worker. */
const definitions = new WeakMap<
  FleetSyncWorld,
  { applied: Record<string, unknown>; selected: Record<string, unknown> }
>();
function withFeatures(
  world: FleetSyncWorld,
  which: 'applied' | 'selected',
  id: string,
  features: unknown
): void {
  const found = definitions.get(world) ?? {
    applied: structuredClone(example) as Record<string, unknown>,
    selected: structuredClone(example) as Record<string, unknown>,
  };
  const worker = (found[which]['workers'] as Record<string, unknown>[]).find(
    (entry) => entry['id'] === id
  )!;
  worker['features'] = features;
  definitions.set(world, found);
}

Given(
  /^the fleet configuration (last applied|to apply) gives the worker "([^"]+)" the features (\{.*\})$/,
  (world, which: string, id: string, features: string) => {
    withFeatures(
      world,
      which === 'last applied' ? 'applied' : 'selected',
      id,
      JSON.parse(features)
    );
  }
);
const plan = (world: FleetSyncWorld): SyncPlan => {
  const found = plans.get(world);
  if (!found) throw new Error('No plan was made.');
  return found;
};

// ── What Git holds ───────────────────────────────────────────────────────

Given(
  'the revision {string} pins, in its mise.toml:',
  (world, revision: string, toml: string) => {
    world.commands.answer(
      (command) =>
        command[0] === 'git' &&
        command[1] === 'show' &&
        command[2] === `${revision}:mise.toml`,
      succeeded(toml)
    );
  }
);

Given(
  'between {string} and {string} these files change:',
  (world, from: string, to: string, table: DataTable) => {
    world.commands.answer(
      ['git', 'diff', '--name-only', from, to].join(' '),
      succeeded(table.list().join('\n') + '\n')
    );
  }
);

Given('no repository on the manager holds an older revision', (world) => {
  world.commands.answer((command) => command[0] === 'git', failed());
});

When(
  /^the plan from "([^"]*)" to "([^"]*)" is made for the machines "([^"]*)"(, restarting a busy T3)?$/,
  async (
    world,
    from: string,
    to: string,
    machines: string,
    busy?: string | null
  ) => {
    const made = await syncPlan(
      {
        from,
        to,
        state: 'in-sync',
        nodes: machines.split(',').map((node) => node.trim()),
        sources: ['/checkout'],
        restartBusy: Boolean(busy),
        ...(definitions.has(world)
          ? { definitions: definitions.get(world)! }
          : {}),
      },
      world.commands.run
    );
    plans.set(world, made);
    world.outcome = { exitCode: 0, data: made, text: planText(made) };
  }
);

Then(
  'the plan lists exactly these tool changes:',
  (world, table: DataTable) => {
    expect(
      plan(world).tools.map((change) => [
        change.tool,
        change.from ?? 'none',
        change.to ?? 'none',
      ])
    ).toEqual(table.rows());
  }
);

Then('the plan lists no tool change', (world) => {
  expect(plan(world).tools).toEqual([]);
});

Then('the plan restarts exactly:', (world, table: DataTable) => {
  expect(
    plan(world).restarts.map((restart) => [
      restart.service,
      restart.endsRunningTurns ? 'yes' : 'no',
    ])
  ).toEqual(table.rows());
});

Then(
  'the plan removes from {string}:',
  (world, node: string, table: DataTable) => {
    expect(
      plan(world).removals.find((removal) => removal.node === node)?.removes
    ).toEqual(table.list());
  }
);

Then('the plan removes nothing', (world) => {
  expect(plan(world).removals).toEqual([]);
});

Then('the plan restarts nothing', (world) => {
  expect(plan(world).restarts).toEqual([]);
});

Then(
  /^the plan says what it changes (is|is not) known$/,
  (world, known: string) => {
    expect(plan(world).known).toBe(known === 'is');
  }
);

Then('the plan prints:', (world, text: string) => {
  expect(world.outcome?.text).toBe(text);
});

Then(
  'the plan moves these machines from {string} to {string}:',
  (world, from: string, to: string, table: DataTable) => {
    expect(
      plan(world).nodes.map((node) => [node.node, node.from, node.to])
    ).toEqual(table.list().map((node) => [node, from, to]));
  }
);

// ── A preview only reads ─────────────────────────────────────────────────

Given('every command answers that it succeeded, printing nothing', (world) => {
  world.commands.answer(() => true, succeeded());
});

When(
  'the manager previews {string} for the roster:',
  async (world, command: string, table: DataTable) => {
    const config = join(temporary(world, 'fleet-preview-'), 'fleet.json');
    writeFileSync(
      config,
      JSON.stringify({ version: 1, nodes: table.hashes().map(rosterEntry) })
    );
    world.outcome = await selected(
      request(command),
      { ...world.settings, config },
      world.commands.run
    );
  }
);

Then(
  'every command the preview ran only reads, and each SSH session ran the read-only platform probe',
  (world) => {
    const READ_ONLY = [
      /^tailscale status --json$/,
      /^scutil --get [A-Za-z]+$/,
      /^ssh -G /,
    ];
    expect(world.commands.calls.length).toBeGreaterThan(0);
    for (const { command } of world.commands.calls) {
      const line = command.join(' ');
      if (command[0] === 'ssh' && command[1] !== '-G') {
        expect(command.at(-1)).toBe(PLATFORM_PROBE);
        continue;
      }
      expect(READ_ONLY.some((pattern) => pattern.test(line))).toBe(true);
    }
  }
);
