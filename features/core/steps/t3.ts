import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { succeeded } from '../../support/commands';
import { verifyT3Endpoint } from '../../../src/t3-endpoint';
import { verifyT3Linked } from '../../../src/t3-linked-check';
import type { Capability, FleetNode } from '../../../src/types';
import { core, need, startsWith, type CoreWorld } from './world';

/** One worker, the link the manager's T3 holds to it, and its private
 * address.
 */
const { Given, When, Then } = core;

const DAY = 86_400_000;

export const worker = (world: CoreWorld): FleetNode =>
  need(world, world.node, 'a worker');

Given('this worker:', (world, table: DataTable) => {
  const row = table.rowsHash();
  world.node = {
    id: row['id'] ?? '',
    ssh: row['ssh'] ?? '',
    workspace: row['workspace'] ?? '',
    required: (row['required']?.split(',') ?? []).map(
      (capability) => capability.trim() as Capability
    ),
    ...(row['tailscaleId'] ? { tailscaleId: row['tailscaleId'] } : {}),
  };
});

Given(
  'the worker is enrolled with the T3 environment {string}',
  (world, environment: string) => {
    worker(world).t3EnvironmentId = environment;
  }
);

Given('the time on the manager is {string}', (world, time: string) => {
  world.clock = Date.parse(time);
});

Given(
  'the worker reports the T3 environment {string} over SSH',
  (world, environmentId: string) => {
    world.commands.answer(
      startsWith('ssh'),
      succeeded(JSON.stringify({ environmentId }))
    );
  }
);

Given(
  'the T3 of the worker was restarted in this sync: its link has {int} seconds to reconnect, looked at every {int} seconds',
  (world, within: number, every: number) => {
    world.reconnect = { withinMs: within * 1000, everyMs: every * 1000 };
  }
);

/** The time the manager goes by: its stopped clock, or the real one, plus
 * what a scenario has spent waiting.
 */
const now = (world: CoreWorld): number =>
  (world.clock ?? Date.now()) + world.waitedMs;

function expiry(world: CoreWorld, expires: string): string {
  const days = /^in (\d+) days$/.exec(expires)?.[1];
  if (!days) throw new Error(`Write when a link expires as "in N days".`);
  return new Date(
    (world.clock ?? Date.now()) + Number(days) * DAY
  ).toISOString();
}

Given('the T3 of the manager lists these links:', (world, table: DataTable) => {
  const rows = table.hashes();
  // Without a `listing` column every listing is the same; with one, a
  // listing shows its own rows and the last goes on being shown.
  const last = Math.max(1, ...rows.map((row) => Number(row['listing'] ?? 1)));
  let listing = 0;
  world.commands.answer(startsWith('t3'), () => {
    listing = Math.min(listing + 1, last);
    return succeeded(
      JSON.stringify(
        rows
          .filter((row) => Number(row['listing'] ?? listing) === listing)
          .map((row) => ({
            environmentId: row['environment'],
            status: row['status'],
            expiresAt: expiry(world, row['expires'] ?? ''),
            // Whatever else T3 keeps about a link, such as its credential.
            ...(row['credential'] ? { credential: row['credential'] } : {}),
          }))
      )
    );
  });
});

When(
  'the link from the manager to the T3 of the worker is checked',
  async (world) => {
    const { reconnect } = world;
    // A scenario that says nothing of time leaves the check to its own clock.
    const options = {
      ...(world.clock !== undefined || reconnect
        ? { now: () => now(world) }
        : {}),
      ...(reconnect
        ? {
            reconnectMs: reconnect.withinMs,
            pause: async () => {
              world.waitedMs += reconnect.everyMs;
            },
          }
        : {}),
    };
    const check = await (Object.keys(options).length > 0
      ? verifyT3Linked(worker(world), world.commands.run, options)
      : verifyT3Linked(worker(world), world.commands.run));
    world.checks = [check];
    world.outcome = check;
  }
);

Given(
  'the address of the worker answers {int} with the body {string}',
  (world, status: number, body: string) => {
    world.respond = () => new Response(body, { status });
  }
);

Given(
  'requests to the address of the worker fail with the error {string}',
  (world, message: string) => {
    world.respond = () => {
      throw new Error(message);
    };
  }
);

Given(
  'the address of the worker answers a request from another origin with these headers:',
  (world, table: DataTable) => {
    const headers = table.rowsHash();
    world.respondForeign = () => new Response('', { status: 200, headers });
  }
);

const foreign = (options: RequestInit): boolean =>
  new Headers(options.headers).has('origin');

When('the manager requests the T3 endpoint of the worker', async (world) => {
  const respond = need(world, world.respond, 'an answer from the worker');
  world.checks = await verifyT3Endpoint(
    worker(world),
    world.commands.run,
    async (url, options) => {
      world.requests.push({ url, options });
      return foreign(options) && world.respondForeign
        ? world.respondForeign()
        : respond();
    }
  );
  world.outcome = world.checks;
});

Then(
  'the request from another origin named the origin {string}',
  (world, origin: string) => {
    const sent = world.requests.filter((request) => foreign(request.options));
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0]!.options.headers).get('origin')).toBe(origin);
  }
);

Then(
  'every request went to {string} and followed no redirect',
  (world, url: string) => {
    expect(world.requests.length).toBeGreaterThan(0);
    for (const request of world.requests) {
      expect(request.url).toBe(url);
      expect(request.options.redirect).toBe('manual');
    }
  }
);
