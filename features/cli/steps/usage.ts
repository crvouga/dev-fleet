import { expect } from 'bun:test';
import { changeWorkers } from '../../../src/state/workers';
import { stateContext } from '../../../src/state/sync';
import { ACTIVITY_PROBE } from '../../../src/worker-activity';
import type { Check } from '../../../src/types';
import { makeReport, reportExitCode } from '../../../src/report';
import { succeeded } from '../../support/commands';
import { declareFleet, workersOf } from '../../support/fleet';
import type { DataTable } from '../../support/gherkin';
import { machine } from './machine';
import { cli, outcome, temporary, type CliWorld } from './world';

/** What fleet-status says of each worker beyond its health: parked or
 * active, and what an active one is doing.
 */
const { Given, Then } = cli;

async function ownState(world: CliWorld): Promise<void> {
  if (world.names['STATE']) return;
  const before = process.env['DEVFLEET_STATE'];
  world.names['STATE'] = await temporary(world, 'fleet-usage-');
  process.env['DEVFLEET_STATE'] = world.names['STATE'];
  world.defer(() => {
    process.env['DEVFLEET_STATE'] = before;
  });
}

Given(
  'the fleet state records {string} as parked at {string}',
  async (world, id: string, at: string) => {
    await ownState(world);
    await changeWorkers(stateContext(machine(world).commands.run), () => ({
      [id]: { parkedAt: at },
    }));
  }
);

Given(
  /^the T3 of "([^"]+)" runs (\d+) agent turns?, its last agent activity was at "([^"]+)", and it is up (\d+) seconds$/,
  (world, id: string, running: string, last: string, uptime: string) => {
    machine(world).commands.answer(
      (command) =>
        command[0] === 'ssh' &&
        command.at(-1) === ACTIVITY_PROBE &&
        command.includes(id),
      succeeded(
        `${uptime}.25\n${JSON.stringify({ version: 1, running: Number(running), lastActivity: last })}\n`
      )
    );
  }
);

Given(
  'fleet.json declares that a worker is idle after {int} hours, and these hourly rates:',
  (world, hours: number, table: DataTable) => {
    const rates = table.rowsHash();
    declareFleet(world, (fleet) => {
      fleet['parking'] = { idleAfterHours: hours };
      for (const worker of workersOf(fleet)) {
        const rate = rates[worker['id'] as string];
        if (rate) {
          const [amount, currency] = rate.split(' ');
          worker['billing'] = { hourlyRate: Number(amount), currency };
        }
      }
    });
  }
);

const usage = (world: CliWorld) =>
  outcome(world).data as {
    workers: Record<string, unknown>[];
    usage: Record<string, unknown>;
  };

Then(
  'in the answer, the worker {string} has:',
  (world, id: string, table: DataTable) => {
    const worker = usage(world).workers.find((entry) => entry['id'] === id);
    const expected = Object.fromEntries(
      Object.entries(table.rowsHash()).map(([key, value]) => [
        key,
        JSON.parse(value) as unknown,
      ])
    );
    expect(worker).toMatchObject(expected);
  }
);

Then(
  'in the answer, the worker {string} has no {string}',
  (world, id: string, field: string) => {
    const worker = usage(world).workers.find((entry) => entry['id'] === id);
    expect(worker).toBeDefined();
    expect(worker![field]).toBeUndefined();
  }
);

Then('in the answer, the usage is:', (world, table: DataTable) => {
  expect(usage(world).usage).toEqual(
    Object.fromEntries(
      Object.entries(table.rowsHash()).map(([key, value]) => [
        key,
        JSON.parse(value) as unknown,
      ])
    )
  );
});

Then(
  'the check {string} of {string} says {string}',
  (world, id: string, node: string, text: string) => {
    const report = outcome(world).data as {
      nodes: { node: string; checks: { id: string; summary: string }[] }[];
    };
    const found = report.nodes
      .find((entry) => entry.node === node)
      ?.checks.find((check) => check.id === id);
    expect(found?.summary).toContain(text);
  }
);

Then(
  'every check of {string} is not applicable, which fails nothing even under --strict',
  (world, node: string) => {
    const report = outcome(world).data as {
      nodes: { node: string; checks: { status: string }[] }[];
    };
    const checks = report.nodes.find((entry) => entry.node === node)!.checks;
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) expect(check.status).toBe('not-applicable');
    // Judged as --strict judges a report that holds only this worker.
    expect(
      reportExitCode(
        makeReport('doctor', [{ node, checks: checks as Check[] }]),
        true
      )
    ).toBe(0);
  }
);
