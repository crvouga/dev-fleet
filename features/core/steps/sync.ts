import { expect } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { succeeded } from '../../support/commands';
import { workspace } from '../../support/fixtures';
import { fingerprint, writeReceipt } from '../../../src/fingerprint';
import { syncPlan, syncWorkspace } from '../../../src/sync';
import { core, need, type CoreWorld } from './world';

/** A checkout on disk, and the sync that brings it to its locked toolchain. */
const { Given, When, Then } = core;

const checkout = (world: CoreWorld): string =>
  need(world, world.checkout, 'a checkout');

Given(
  'a complete checkout at the revision {string}',
  async (world, revision: string) => {
    const directory = await workspace();
    world.defer(() => rm(directory, { recursive: true, force: true }));
    world.checkout = directory;
    world.revision = revision;
    // Git answers for a clean checkout on a branch, until a scenario says
    // otherwise; nothing else it runs fails either.
    world.commands.otherwise = succeeded();
    world.commands.answer(
      (command) => command.includes('rev-parse'),
      succeeded(revision)
    );
  }
);

Given('the checkout holds the receipt of an earlier sync', async (world) => {
  // Written the way a sync writes it, by a Git that is asked nothing else.
  const current = await fingerprint(checkout(world), async (command) =>
    succeeded(command.includes('rev-parse') ? world.revision : '')
  );
  await writeReceipt(checkout(world), current);
});

When(
  /^the checkout is synced (with|without) a pull$/,
  async (world, pull: string) => {
    world.checks = await syncWorkspace(
      checkout(world),
      pull === 'with',
      world.commands.run
    );
    world.outcome = world.checks;
  }
);

When(/^a sync (with|without) a pull is planned$/, (world, pull: string) => {
  world.text = syncPlan(pull === 'with').join(' ');
});

Then(
  /^the plan (mentions|does not mention) "(.*)"$/,
  (world, verdict: string, text: string) => {
    const plan = need(world, world.text, 'a plan');
    if (verdict === 'mentions') expect(plan).toContain(text);
    else expect(plan).not.toContain(text);
  }
);

Then('the checkout holds no file {string}', async (world, path: string) => {
  expect(await Bun.file(join(checkout(world), path)).exists()).toBe(false);
});

Then(
  'the receipt {string} in the checkout has the version {int}',
  async (world, path: string, version: number) => {
    const receipt = JSON.parse(
      await readFile(join(checkout(world), path), 'utf8')
    ) as { version: unknown };
    expect(receipt.version).toBe(version);
  }
);
