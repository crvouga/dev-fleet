import { expect } from 'bun:test';
import { probe } from '../../../src/probe';
import { tailnetHealth } from '../../../src/tailnet-health';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  capabilities,
  checksIn,
  isSession,
  need,
  orchestration,
  sessions,
  type OrchestrationWorld,
} from '../support/world';

const { Given, When, Then } = orchestration;

Given(
  'Tailscale discovery left out {int} mobile device(s) and reported these checks:',
  (world, excluded: number, table: DataTable) => {
    world.health = { excludedMobile: excluded, checks: checksIn(table) };
  }
);

Given(
  'a probed worker answers with the snapshot of that checkout when no capability is required',
  async (world) => {
    const snapshot = await probe(need(world.root, 'a checkout'), [], world.run);
    world.commands.answer(isSession, succeeded(JSON.stringify(snapshot)));
  }
);

Given(
  'preparing the probe source fails with the error {string}',
  (world, message: string) => {
    world.probe.error = message;
  }
);

/** How long the manager would wait for one probe; nothing here takes time. */
const PROBE_TIMEOUT_MS = 300_000;

When('the health of the tailnet is inspected', async (world) => {
  world.reports = await tailnetHealth(
    { computers: world.computers, ...world.health },
    world.nodes,
    {
      root: need(world.root, 'a checkout'),
      timeoutMs: PROBE_TIMEOUT_MS,
      source: async () => {
        world.probe.preparations += 1;
        if (world.probe.error !== undefined) throw new Error(world.probe.error);
        return need(world.probe.source, 'a probe source');
      },
    },
    world.run
  );
  world.outcome = world.reports;
});

Then('no probe was sent over SSH', (world) => {
  expect(sessions(world)).toHaveLength(0);
});

Then('{int} probe(s) was/were sent over SSH', (world, count: number) => {
  expect(sessions(world)).toHaveLength(count);
});

/** The capabilities each probe was told its worker requires: the request is
 * the last, quoted, base64 argument of the command the session runs.
 */
function required(world: OrchestrationWorld): string[][] {
  expect(sessions(world).length).toBeGreaterThan(0);
  return sessions(world).map(({ command }) => {
    const encoded = need(
      /'([^']+)'$/.exec(command.at(-1) ?? '')?.[1],
      'a request at the end of the probe command'
    );
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
      node: { required: string[] };
    };
    return request.node.required;
  });
}

Then(
  'every probe required exactly the capabilities {string}',
  (world, names: string) => {
    for (const asked of required(world))
      expect(asked).toEqual(capabilities(names));
  }
);

Then(
  'no probe required the capability {string}',
  (world, capability: string) => {
    for (const asked of required(world))
      expect(asked).not.toContain(capability);
  }
);

Then('the probe source was prepared {int} time(s)', (world, count: number) => {
  expect(world.probe.preparations).toBe(count);
});
