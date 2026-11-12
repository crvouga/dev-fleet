import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  tailnetControl,
  type TailnetControl,
} from '../../../src/tailnet-control';
import { declareFleet } from '../../support/fleet';
import type { DataTable } from '../../support/gherkin';
import { cli, outcome, type CliWorld } from './world';

/** The tailnet control plane fleet-status asks for devices tagged as
 * workers, answered from memory: the HTTP layer is the stand-in, the client
 * is dev-fleet's own.
 */
const { Given, Then } = cli;

interface Plane {
  devices: { nodeId: string; hostname: string; tags: string[] }[];
  /** Made per scenario, so no credential-shaped literal is committed. */
  credential: string | null;
  asked: number;
}
const planes = new WeakMap<CliWorld, Plane>();

function plane(world: CliWorld): Plane {
  let found = planes.get(world);
  if (!found) {
    found = { devices: [], credential: null, asked: 0 };
    planes.set(world, found);
  }
  return found;
}

/** What fleet-status asks the control plane with in a scenario. */
export function leftoverControl(
  world: CliWorld
): (() => Promise<TailnetControl | null>) | undefined {
  const found = planes.get(world);
  if (!found) return undefined;
  return () =>
    Promise.resolve(
      found.credential === null
        ? null
        : tailnetControl(
            { api: 'tailscale', tag: 'tag:fleet-worker' },
            found.credential,
            async () => {
              found.asked += 1;
              return { status: 200, body: { devices: found.devices } };
            }
          )
    );
}

Given(
  'fleet.json declares the hosted Tailscale as its control plane, tagging workers {string}',
  (world, tag: string) => {
    declareFleet(world, (fleet) => {
      fleet['tailnet'] = { api: 'tailscale', tag };
    });
    plane(world).credential = `placeholder-admin-${randomUUID()}`;
  }
);

Given('fleet.json declares no tailnet control plane', (world) => {
  plane(world).credential = null;
});

Given('the control plane lists these devices:', (world, table: DataTable) => {
  plane(world).devices = (
    table.hashes() as { id: string; name: string; tags: string }[]
  ).map((row) => ({
    nodeId: row.id,
    hostname: row.name,
    tags: row.tags.split(' '),
  }));
});

const leftovers = (world: CliWorld) =>
  (
    outcome(world).data as {
      nodes: {
        node: string;
        checks: { id: string; status: string; summary: string }[];
      }[];
    }
  ).nodes.flatMap((node) =>
    node.checks.filter((check) => check.id === 'tailscale:leftover')
  );

Then(
  'fleet-status warns of exactly these leftover devices:',
  (world, table: DataTable) => {
    const found = leftovers(world);
    expect(found.every((check) => check.status === 'warn')).toBe(true);
    const names = table.list();
    expect(found).toHaveLength(names.length);
    names.forEach((name, index) =>
      expect(found[index]!.summary).toContain(`the device ${name},`)
    );
  }
);

Then('fleet-status reports no leftover device', (world) => {
  expect(leftovers(world)).toEqual([]);
});

Then('the control plane was asked nothing', (world) => {
  expect(plane(world).asked).toBe(0);
});
