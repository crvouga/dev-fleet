import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetManifest } from '../../../src/cli/fleet-manifest';
import {
  manifestDigest,
  parseManifest,
  ubuntuPolicy,
  type WorkerManifest,
} from '../../../src/worker-manifest';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { fleetSync, type FleetSyncWorld } from '../support/world';

/** fleet-manifest, with the worker's listings written in the scenario. */
const { Given, When, Then } = fleetSync;

interface Measuring {
  directory: string;
  packages: [string, string][];
  tools: Record<string, { version: string }[]>;
  units: [string, string][];
  /** The `VERSION_ID` the worker reports, when the scenario names one. */
  release?: string;
  measured: WorkerManifest[];
  reference?: string;
}
const measurings = new WeakMap<FleetSyncWorld, Measuring>();

const measuring = (world: FleetSyncWorld): Measuring => {
  const found = measurings.get(world);
  if (!found) throw new Error('The scenario describes no worker to measure.');
  return found;
};

/** What the worker prints for the probe, in the order given. */
function listing(state: Measuring, reverse = false): string {
  const order = <T>(items: T[]) => (reverse ? [...items].reverse() : items);
  const tools = Object.fromEntries(order(Object.entries(state.tools)));
  return [
    '@packages',
    ...order(state.packages).map(([name, version]) => `${name}=${version}`),
    '@tools',
    JSON.stringify(tools),
    '@units',
    ...order(state.units).map(([name, value]) => `${name}=${value}`),
    ...(state.release ? ['@release', state.release] : []),
    '',
  ].join('\n');
}

function answer(world: FleetSyncWorld): void {
  world.commands.answer(
    (command) => command[0] === 'ssh',
    () => succeeded(listing(measuring(world)))
  );
}

Given(
  'a worker with every package and service policy.json declares, and these tools:',
  async (world, table: DataTable) => {
    const policy = await ubuntuPolicy();
    const directory = mkdtempSync(join(tmpdir(), 'devfleet-manifest-'));
    world.defer(() => rmSync(directory, { recursive: true, force: true }));
    measurings.set(world, {
      directory,
      packages: Object.entries(policy.packages),
      tools: Object.fromEntries(
        Object.entries(table.rowsHash()).map(([tool, version]) => [
          tool,
          [{ version }],
        ])
      ),
      units: policy.alwaysOnServices.map((unit) => [unit, 'enabled/active']),
      measured: [],
    });
    answer(world);
  }
);

Given(
  'the worker runs Ubuntu {string}, with every package at the pin of that release',
  async (world, release: string) => {
    const policy = await ubuntuPolicy();
    const state = measuring(world);
    state.release = release;
    state.packages = Object.entries({
      ...policy.packages,
      ...policy.releases.find((entry) => entry.release === release)?.packages,
    });
  }
);

Given("the fresh build's manifest is the worker's own", (world) => {
  const state = measuring(world);
  state.reference = join(state.directory, 'fresh.json');
  writeFileSync(
    state.reference,
    JSON.stringify({ manifest: parseManifest(listing(state)) })
  );
});

Given(
  'someone installed the package {string} at {string} on the worker',
  (world, name: string, version: string) => {
    measuring(world).packages.push([name, version]);
  }
);

Given(
  'someone upgraded the package {string} to {string} on the worker',
  (world, name: string, version: string) => {
    const state = measuring(world);
    state.packages = state.packages.map(([entry, pinned]) => [
      entry,
      entry === name ? version : pinned,
    ]);
  }
);

Given('the manifest of the worker was measured', (world) => {
  measuring(world).measured.push(parseManifest(listing(measuring(world))));
});

When(
  'the manifest of a second build, listing everything in reverse order, is measured',
  (world) => {
    measuring(world).measured.push(
      parseManifest(listing(measuring(world), true))
    );
  }
);

When(
  /^the operator runs fleet-manifest for "([^"]+)"( against the fresh build)?$/,
  async (world, id: string, fresh: string | null) => {
    const state = measuring(world);
    const roster = join(state.directory, 'roster.json');
    writeFileSync(roster, JSON.stringify({ version: 1, nodes: [world.node] }));
    world.outcome = await fleetManifest(
      {
        id,
        ...(fresh && state.reference ? { reference: state.reference } : {}),
      },
      { run: world.commands.run, roster }
    );
  }
);

Then('both manifests and their digests are identical', (world) => {
  const [first, second] = measuring(world).measured;
  expect(Object.keys(first!.packages).length).toBeGreaterThan(10);
  expect(second).toEqual(first!);
  expect(manifestDigest(second!)).toBe(manifestDigest(first!));
});

const check = (world: FleetSyncWorld, id: string) =>
  (
    world.outcome!.data as {
      checks: { id: string; status: string; summary: string }[];
    }
  ).checks.find((entry) => entry.id === id);

Then('the reported check {string} passes', (world, id: string) => {
  expect(check(world, id)?.status).toBe('pass');
});

Then(
  'the check {string} fails, naming {string}',
  (world, id: string, text: string) => {
    expect(check(world, id)?.status).toBe('fail');
    expect(check(world, id)?.summary).toContain(text);
  }
);

Then(
  'the worker was asked only to list, with dpkg-query, mise ls and systemctl is-enabled and is-active',
  (world) => {
    const [probe] = world.commands.ran((command) => command[0] === 'ssh');
    const script = probe!.at(-1)!;
    expect(script).toContain('dpkg-query -W');
    expect(script).toContain('mise ls --current --json');
    const verbs = [...script.matchAll(/systemctl (\S+)/g)].map(
      (match) => match[1]
    );
    expect(new Set(verbs)).toEqual(new Set(['is-enabled', 'is-active']));
    expect(script).not.toMatch(/apt|install|rm |mise (use|install)/);
  }
);
