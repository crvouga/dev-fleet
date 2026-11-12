import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deployWorker } from '../../../src/cli/fleet-sync-worker';
import { tailnetControl } from '../../../src/tailnet-control';
import type { TailnetComputer } from '../../../src/tailscale';
import type { Check, CommandResult, NodeReport } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  checkFrom,
  definition,
  fleetSync,
  type FleetSyncWorld,
} from '../support/world';
import { controlPlane, http } from './tailnet';

/** One worker's deployment around its converge: the converge, the playbooks
 * the manager applies and the tailnet answer from memory.
 */
const { Given, When, Then } = fleetSync;

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null)
    throw new Error(`The scenario needs ${what}.`);
  return value;
}

const REVISION = 'a'.repeat(40);

interface Arrival {
  /** What the first converge reports, then what every later one does. */
  first?: Check[];
  after?: Check[];
  converges: { ssh: string; workspace: string; key?: string }[];
  computers: TailnetComputer[];
  readyBefore: string[];
  playbooks: Map<string, CommandResult>;
  applied: { name: string; variables: Record<string, unknown> }[];
  report?: NodeReport;
}
const arrivals = new WeakMap<FleetSyncWorld, Arrival>();

export function arrival(world: FleetSyncWorld): Arrival {
  let found = arrivals.get(world);
  if (!found) {
    found = {
      converges: [],
      computers: [],
      readyBefore: [],
      playbooks: new Map(),
      applied: [],
    };
    arrivals.set(world, found);
  }
  return found;
}

Given('no worker converged in an earlier run', (world) => {
  arrival(world).readyBefore = [];
});

Given('{string} converged in an earlier run', (world, id: string) => {
  arrival(world).readyBefore.push(id);
});

Given(
  'the control plane answers 200 with a key generated for this scenario',
  (world) => {
    controlPlane(world).answer = {
      status: 200,
      body: {
        key: ['tskey', 'auth', randomUUID()].join('-'),
        expires: '2026-11-12T10:10:00Z',
      },
    };
  }
);

Given(
  /^the tailnet shows "([^"]+)" with a node key that (?:never expires|expires in (\d+) days)$/,
  (world, id: string, days: string | undefined) => {
    arrival(world).computers.push({
      id,
      name: id,
      dns: `${id}.example.ts.net`,
      os: 'linux',
      ips: ['100.64.0.2'],
      online: true,
      self: false,
      ...(days ? { keyExpiry: Date.now() + Number(days) * 86_400_000 } : {}),
    });
  }
);

const checks = (table: DataTable): Check[] => table.hashes().map(checkFrom);

Given('each converge reports:', (world, table: DataTable) => {
  arrival(world).first = checks(table);
  arrival(world).after = checks(table);
});

Given('the first converge reports:', (world, table: DataTable) => {
  arrival(world).first = checks(table);
});

Given('each converge after it reports:', (world, table: DataTable) => {
  arrival(world).after = checks(table);
});

Given('the playbook {string} succeeds', (world, name: string) => {
  arrival(world).playbooks.set(name, succeeded());
});

Given(
  'the playbook {string} fails, printing {string}',
  (world, name: string, output: string) => {
    arrival(world).playbooks.set(name, { ...failed(), stdout: output });
  }
);

When(
  /^the worker is deployed(?: with (--maintenance-reboot(?: --force)?))?$/,
  async (world, flags: string | undefined) => {
    const state = arrival(world);
    const plane = controlPlane(world);
    const config = need(plane.config, 'a tailnet control plane');
    state.report = await deployWorker(
      need(world.node, 'a roster entry'),
      REVISION,
      {
        definition: { ...definition, tailnet: config },
        playbook: (name, variables) => {
          state.applied.push({
            name,
            variables: variables as Record<string, unknown>,
          });
          return Promise.resolve(
            state.playbooks.get(name) ?? failed('no answer for this playbook')
          );
        },
        converge: (node, revision, key) => {
          expect(revision).toBe(REVISION);
          state.converges.push({
            ssh: node.ssh,
            workspace: node.workspace,
            ...(key ? { key } : {}),
          });
          const reported =
            state.converges.length === 1 ? state.first : state.after;
          return Promise.resolve({
            node: node.id,
            checks: need(reported, 'what a converge reports').map((check) => ({
              ...check,
            })),
          });
        },
        control: () =>
          Promise.resolve(
            plane.credential
              ? tailnetControl(config, plane.credential, http(world))
              : null
          ),
        computers: () => Promise.resolve(state.computers),
        readyBefore: state.readyBefore,
        ...(flags ? { maintenanceReboot: true } : {}),
        ...(flags?.includes('--force') ? { force: true } : {}),
        acceptsTailnetKey: true,
      }
    );
  }
);

const report = (world: FleetSyncWorld): NodeReport =>
  need(arrival(world).report, 'a deployment');

const reported = (world: FleetSyncWorld, id: string): Check =>
  need(
    report(world).checks.find((check) => check.id === id),
    `a check "${id}"`
  );

Then(/^the worker was converged (\d+) times?$/, (world, count: string) => {
  expect(arrival(world).converges).toHaveLength(Number(count));
});

Then(
  'its first converge was handed the key the control plane issued',
  (world) => {
    const issued = (controlPlane(world).answer.body as { key: string }).key;
    expect(arrival(world).converges[0]?.key).toBe(issued);
  }
);

Then('no converge was handed a key', (world) => {
  expect(arrival(world).converges.some((converge) => converge.key)).toBe(false);
});

Then('nothing the deployment reports holds the key', (world) => {
  const issued = (controlPlane(world).answer.body as { key: string }).key;
  expect(JSON.stringify(report(world))).not.toContain(issued);
});

Then(
  '{string} appears nowhere in what the deployment reports',
  (world, sentinel: string) => {
    expect(JSON.stringify(report(world))).not.toContain(sentinel);
  }
);

Then(
  /^the deployment reports "([^"]+)" as "([^"]+)"(?:, saying "([^"]+)")?$/,
  (world, id: string, status: string, saying: string | undefined) => {
    const check = reported(world, id);
    expect(check.status).toBe(status as Check['status']);
    if (saying) expect(check.summary).toContain(saying);
  }
);

Then('no check of the deployment says {string}', (world, summary: string) => {
  expect(report(world).checks.map((check) => check.summary)).not.toContain(
    summary
  );
});

Then(
  'the remedy of {string} names {string}',
  (world, id: string, text: string) => {
    expect(reported(world, id).remedy?.action).toContain(text);
  }
);

Then(
  'the last converge reached it as {string}, with the workspace {string}',
  (world, ssh: string, workspace: string) => {
    expect(arrival(world).converges.at(-1)).toMatchObject({ ssh, workspace });
  }
);

Then(
  'the playbook {string} was applied with:',
  (world, name: string, table: DataTable) => {
    const applied = need(
      arrival(world).applied.find((entry) => entry.name === name),
      `an application of ${name}`
    );
    for (const { variable, value } of table.hashes())
      expect(String(applied.variables[variable!])).toBe(value!);
  }
);

Then('the manager applied no playbook to the worker', (world) => {
  expect(arrival(world).applied).toEqual([]);
});
