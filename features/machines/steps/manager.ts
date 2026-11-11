import { expect } from 'bun:test';
import { access, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fleet } from '../../../src/fleet-config';
import { approvedLocalSource } from '../../../src/machine/local-source';
import { readEnrollment, withMachineLock } from '../../../src/machine/state';
import { machines, temporary } from './world';
import type { MachinesWorld } from './world';

const { Given, When, Then } = machines;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

Given('an empty manager state directory', async (world) => {
  world.directory = await temporary(world, 'manager-state-');
});

Given(
  'the directory holds {string}:',
  async (world, name: string, content: string) => {
    await writeFile(join(world.directory, name), content);
  }
);

Given('a file {string} in the directory', async (world, name: string) => {
  await writeFile(join(world.directory, name), 'stale');
});

Then('{string} is gone from the directory', async (world, name: string) => {
  expect(await exists(join(world.directory, name))).toBe(false);
});

Then('{string} is still in the directory', async (world, name: string) => {
  expect(await exists(join(world.directory, name))).toBe(true);
});

// ── The earlier enrollment ───────────────────────────────────────────────

When('the earlier enrollment is read', async (world) => {
  await world.attempt(async () => {
    world.enrollment = await readEnrollment(world.directory);
  });
});

function read(world: MachinesWorld): MachinesWorld['enrollment'] {
  if (world.failure !== undefined) throw world.failure;
  return world.enrollment;
}

Then('there is no earlier enrollment', (world) => {
  expect(read(world)).toBeNull();
});

Then('its approved revision is {string}', (world, revision: string) => {
  expect(read(world)?.approvedRevision).toBe(revision);
});

Then('it names no applied revision', (world) => {
  expect(read(world)).toBeTruthy();
  expect(read(world)?.appliedRevision).toBeUndefined();
});

// ── The lock ─────────────────────────────────────────────────────────────

const lock = (world: MachinesWorld): string =>
  join(world.directory, 'sync.lock');

Given('a sync is running', async (world) => {
  let finish = (): void => {};
  let begun = (): void => {};
  const finished = new Promise<void>((done) => (finish = done));
  const began = new Promise<void>((done) => (begun = done));
  const sync = withMachineLock(world.directory, async () => {
    begun();
    await finished;
  });
  world.defer(async () => {
    finish();
    await sync;
  });
  // A sync that cannot take the lock fails here instead of never beginning.
  await Promise.race([began, sync]);
});

Given('a sync ran to its end', async (world) => {
  await withMachineLock(world.directory, async () => 'earlier');
});

Given('a lock whose owner is recorded as:', async (world, owner: string) => {
  await mkdir(lock(world));
  await writeFile(join(lock(world), 'owner.json'), owner);
});

Given(
  'a lock whose owner is recorded as the process running these scenarios',
  async (world) => {
    await mkdir(lock(world));
    await writeFile(
      join(lock(world), 'owner.json'),
      JSON.stringify({ version: 1, pid: process.pid })
    );
  }
);

Given('a lock that records no owner', async (world) => {
  await mkdir(lock(world));
});

Given(
  'the lock was last changed {int} seconds ago',
  async (world, seconds: number) => {
    const then = new Date(Date.now() - seconds * 1000);
    await utimes(lock(world), then, then);
  }
);

When('another sync starts', async (world) => {
  await world.attempt(async () => {
    world.ran = await withMachineLock(world.directory, async () => 'ran');
  });
});

Then('it runs', (world) => {
  if (world.failure !== undefined) throw world.failure;
  expect(world.ran).toBe('ran');
});

// ── A local checkout ─────────────────────────────────────────────────────

Given(
  'the fleet configuration names the source repository {string}',
  (_world, repository: string) => {
    expect(fleet.source.repository).toBe(repository);
  }
);

When(
  'the commit {string} is looked for in the checkout {string}',
  async (world, revision: string, checkout: string) => {
    world.source = await approvedLocalSource(checkout, revision, world.run);
  }
);

Then('the checkout {string} supplies it', (world, checkout: string) => {
  expect(world.source).toBe(checkout);
});

Then('no checkout supplies it', (world) => {
  expect(world.source).toBeNull();
});
