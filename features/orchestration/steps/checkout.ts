import { expect } from 'bun:test';
import { authCheck } from '../../../src/auth-checks';
import { CAPABILITIES } from '../../../src/config';
import {
  compareFingerprints,
  dependencyCheck,
  fingerprint,
  writeReceipt,
} from '../../../src/fingerprint';
import { probe } from '../../../src/probe';
import { runCommand } from '../../../src/runner';
import { inspectRemote } from '../../../src/transport';
import type { Capability, Fingerprint } from '../../../src/types';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { bundledProbe } from '../support/probe';
import { need, orchestration, type OrchestrationWorld } from '../support/world';

const { Given, When, Then } = orchestration;

const current = (world: OrchestrationWorld): Promise<Fingerprint> =>
  fingerprint(need(world.root, 'a checkout'), world.run);

// ── Fingerprints ─────────────────────────────────────────────────────────

When(
  'the fingerprint of the checkout is compared with itself',
  async (world) => {
    world.fingerprint = await current(world);
    world.checks = compareFingerprints(world.fingerprint, world.fingerprint);
  }
);

When(
  'the fingerprint of the checkout is compared with the reference',
  async (world) => {
    world.fingerprint = await current(world);
    world.checks = compareFingerprints(
      need(world.reference, 'a reference fingerprint'),
      world.fingerprint
    );
  }
);

When(
  'two fingerprints that name no commit and hold no hash are compared',
  (world) => {
    world.checks = compareFingerprints(
      { head: null, files: {} },
      { head: null, files: {} }
    );
  }
);

When('the fingerprint of the checkout is taken again', async (world) => {
  world.fingerprint = await current(world);
});

Then('the fingerprint names the commit {string}', (world, commit: string) => {
  expect(need(world.fingerprint, 'a fingerprint').head).toBe(commit);
});

Then('its {string} hash differs from the reference', (world, input: string) => {
  expect(need(world.fingerprint, 'a fingerprint').files[input]).not.toBe(
    need(world.reference, 'a reference fingerprint').files[input]
  );
});

// ── Dependencies ─────────────────────────────────────────────────────────

Given(
  'a sync receipt was written for the inputs of the checkout',
  async (world) => {
    await writeReceipt(need(world.root, 'a checkout'), await current(world));
  }
);

When('the dependencies of the checkout are checked', async (world) => {
  world.checks = [
    await dependencyCheck(need(world.root, 'a checkout'), await current(world)),
  ];
});

// ── Capabilities ─────────────────────────────────────────────────────────

When('the checkout is probed for no capability', async (world) => {
  world.snapshot = await probe(need(world.root, 'a checkout'), [], world.run);
  world.checks = world.snapshot.checks;
  world.outcome = world.snapshot;
});

Then(
  'exactly these capabilities are skipped, and they are every capability there is:',
  (world, table: DataTable) => {
    expect(table.list()).toEqual(CAPABILITIES);
    const skipped = world.checks.filter((check) => check.status === 'skip');
    expect(skipped.length).toBe(CAPABILITIES.length);
    expect(skipped.map((check) => check.id)).toEqual(
      table.list().map((capability) => `auth:${capability}`)
    );
  }
);

When(
  'the capability {string} is checked for the checkout {string}',
  async (world, capability: string, root: string) => {
    world.checks = await authCheck(capability as Capability, world.run, root);
    world.outcome = world.checks;
  }
);

Given(
  'the shell finds the t3 executable only at {string}',
  (world, path: string) => {
    world.commands.answer(
      (command) => command[0] === 'sh',
      succeeded(`${path}\n`)
    );
  }
);

Then(
  'besides the shell, these executables were run, in order:',
  (world, table: DataTable) => {
    expect(
      world.commands.calls
        .filter((call) => call.command[0] !== 'sh')
        .map((call) => call.command[0] ?? '')
    ).toEqual(table.list());
  }
);

// ── The probe on a worker ────────────────────────────────────────────────

Given(
  'the runtime of the worker is the Bun that runs these features',
  (world) => {
    need(world.nodes[0], 'a worker').runtime = process.execPath;
  }
);

Given('an SSH session runs its command in a local shell', (world) => {
  world.commands.answer(
    () => true,
    (command, options) =>
      runCommand(['sh', '-c', need(command.at(-1), 'a command')], options)
  );
});

/** Long enough for one local process to start and answer. */
const PROBE_TIMEOUT_MS = 5000;

When(
  'the manager probes the worker with the probe bundled from the current source',
  async (world) => {
    const report = await inspectRemote(
      need(world.nodes[0], 'a worker'),
      {
        source: await bundledProbe(),
        timeoutMs: PROBE_TIMEOUT_MS,
        action: 'probe',
      },
      world.run
    );
    world.checks = report.checks;
    world.snapshot = report.snapshot;
    world.outcome = report;
  }
);

Then('the snapshot is of version {int}', (world, version: number) => {
  expect<number | undefined>(world.snapshot?.version).toBe(version);
});

Then(
  'the {string} hash of the snapshot is 64 hexadecimal characters',
  (world, input: string) => {
    expect(world.snapshot?.fingerprint.files[input]).toMatch(/^[a-f0-9]{64}$/);
  }
);
