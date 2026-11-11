import { expect } from 'bun:test';
import { mkdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  T3_RESTARTED_SUMMARY,
  loadedT3Policy,
  stableWorkspace,
  verifyT3Policy,
} from '../../../src/platform/t3-policy';
import { convergeT3Route } from '../../../src/platform/t3-route';
import { convergeT3Service } from '../../../src/platform/t3-service';
import { succeeded } from '../../support/commands';
import { commandLine } from '../../support/answers';
import { machines, temporary } from './world';

const { Given, When, Then } = machines;

// ── The policy T3 has loaded ─────────────────────────────────────────────

When(
  'the policy loaded by the T3 at {string} is measured',
  async (world, executable: string) => {
    world.checks = [
      await verifyT3Policy(executable, world.run, async () => {
        world.pauses++;
      }),
    ];
  }
);

When(
  /^the policy loaded by the T3 at "([^"]+)" is measured after a play that (restarted it|left it running)$/,
  async (world, executable: string, play: string) => {
    world.checks = [
      await loadedT3Policy(executable, world.run, {
        restarted: play === 'restarted it',
        pause: async () => {
          world.pauses++;
        },
      }),
    ];
  }
);

Then('the measurement paused {int} times', (world, count: number) => {
  expect(world.pauses).toBe(count);
});

Then('that summary is the one the manager takes as a restart', (world) => {
  expect(world.check.summary).toBe(T3_RESTARTED_SUMMARY);
});

Then(
  'the summary of the check is not the one the manager takes as a restart',
  (world) => {
    expect(world.check.summary).not.toBe(T3_RESTARTED_SUMMARY);
  }
);

// ── The desktop app ──────────────────────────────────────────────────────

Given(
  'the pinned T3 release is {string}, installed at {string}',
  (world, version: string, path: string) => {
    world.artifact = { path, version };
  }
);

Given('installing the desktop app fails', (world) => {
  world.installs = false;
});

When("the worker's T3 desktop app is converged", async (world) => {
  world.checks = await convergeT3Service(
    world.artifact,
    world.run,
    async () => {
      world.staged = true;
      return [];
    },
    async () => {
      world.installed = true;
      return world.installs;
    }
  );
});

Then('the policy was not staged', (world) => {
  expect(world.staged).toBe(false);
});

Then('the desktop app was not installed', (world) => {
  expect(world.installed).toBe(false);
});

// ── The private route ────────────────────────────────────────────────────

Given(/^publishing the route (succeeds|fails)$/, (world, outcome: string) => {
  world.publishes = outcome === 'succeeds';
});

Given(
  'until the route is published the command {string} prints {string}, and afterwards:',
  (world, command: string, before: string, after: string) => {
    world.commands.answer(commandLine(command), () =>
      succeeded(world.published ? after : before)
    );
  }
);

When("the worker's private T3 route is converged", async (world) => {
  world.checks = await convergeT3Route(world.run, async () => {
    world.publishAsked = true;
    world.published = world.publishes;
    return world.publishes;
  });
});

Then(/^the route was (published|not published)$/, (world, outcome: string) => {
  expect(world.publishAsked).toBe(outcome === 'published');
});

// ── The workspace link ───────────────────────────────────────────────────

const revision = (fleet: string, commit: string): string =>
  join(fleet, 'revisions', commit);

Given(
  'a fleet directory that holds the revisions {string} and {string}',
  async (world, first: string, second: string) => {
    world.directory = await temporary(world, 'fleet-');
    for (const commit of [first, second])
      await mkdir(revision(world.directory, commit), { recursive: true });
  }
);

Given(
  'the revision {string} is the one T3 references',
  async (world, commit: string) => {
    world.before = await stableWorkspace(revision(world.directory, commit));
  }
);

When(
  'the revision {string} becomes the one T3 references',
  async (world, commit: string) => {
    world.referenced = await stableWorkspace(revision(world.directory, commit));
  }
);

When(
  'the checkout {string} becomes the one T3 references',
  async (world, checkout: string) => {
    world.referenced = await stableWorkspace(checkout);
  }
);

Then('T3 references {string} in the fleet directory', (world, name: string) => {
  expect(world.referenced).toBe(join(world.directory, name));
});

Then('T3 references {string}', (world, path: string) => {
  expect(world.referenced).toBe(path);
});

Then('T3 references the same path as before', (world) => {
  expect(world.before).not.toBe('');
  expect(world.referenced).toBe(world.before);
});

Then(
  '{string} links to {string}',
  async (world, name: string, target: string) => {
    expect(await readlink(join(world.directory, name))).toBe(
      join(...target.split('/'))
    );
  }
);

Then(
  '{string} resolves to the revision {string}',
  async (world, name: string, commit: string) => {
    expect(await realpath(join(world.directory, name))).toBe(
      await realpath(revision(world.directory, commit))
    );
  }
);
