import { expect } from 'bun:test';
import { managerText, splitSummary } from '../../../src/cli/fleet-sync-output';
import type { ManagerNode, ManagerReport } from '../../../src/manager-sync';
import type { DataTable } from '../../support/gherkin';
import {
  checkFrom,
  escaped,
  fleetSync,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** A report as fleet-sync builds it, and what was printed of it. */
interface Printing {
  report: ManagerReport | undefined;
  printed: string;
  split: { code: string; detail: string } | undefined;
}
const states = new WeakMap<FleetSyncWorld, Printing>();

function state(world: FleetSyncWorld): Printing {
  let found = states.get(world);
  if (!found) {
    found = { report: undefined, printed: '', split: undefined };
    states.set(world, found);
  }
  return found;
}

Given(
  'a fleet-sync report that applied the revision {string}, with the dashboard {string}',
  (world, revision: string, dashboardUrl: string) => {
    state(world).report = {
      desiredRevision: revision,
      applied: true,
      candidates: 0,
      dashboardUrl,
      checks: [],
      nodes: [],
    } as unknown as ManagerReport;
  }
);

Given(
  /^the worker "([^"]*)", online and applied at (?:no revision|"([^"]*)") after (\d+) ms, reports:$/,
  (
    world,
    node: string,
    applied: string | undefined,
    durationMs: number,
    table: DataTable
  ) => {
    state(world).report!.nodes.push({
      node,
      role: 'worker',
      reachability: 'online',
      appliedRevision: applied ?? null,
      durationMs: Number(durationMs),
      checks: table.hashes().map(checkFrom),
    } as unknown as ManagerNode);
  }
);

When(
  'the report is printed in plain text, for a run of {int} ms saved at {string}',
  (world, durationMs: number, reportPath: string) => {
    state(world).printed = managerText(state(world).report!, {
      reportPath,
      durationMs,
    });
  }
);

When('the report is printed in plain text', (world) => {
  state(world).printed = managerText(state(world).report!);
});

When('the report is printed in color', (world) => {
  state(world).printed = managerText(state(world).report!, { color: true });
});

Then('the first line printed is {string}', (world, line: string) => {
  expect(state(world).printed.split('\n')[0]).toBe(line);
});

Then('the grid printed has these lines:', (world, table: DataTable) => {
  // Columns are padded with spaces; a line is its cells and nothing else.
  for (const cells of table.raw())
    expect(state(world).printed).toMatch(
      new RegExp(`^${cells.map(escaped).join(' +')}$`, 'm')
    );
});

Then('the printed report contains {string}', (world, text: string) => {
  expect(state(world).printed).toContain(text);
});

Then('the printed report does not name {string}', (world, text: string) => {
  expect(state(world).printed).not.toMatch(new RegExp(escaped(text)));
});

Then(
  'the printed report names {string} {int} time',
  (world, text: string, count: number) => {
    expect(
      state(world).printed.match(new RegExp(escaped(text), 'g'))
    ).toHaveLength(count);
  }
);

const COLOR = /\u001b\[/;

Then('the printed report has no color', (world) => {
  expect(state(world).printed).not.toMatch(COLOR);
});

Then('the printed report has color', (world) => {
  expect(state(world).printed).toMatch(COLOR);
});

Then('nothing in the printed report is red', (world) => {
  // Red is the color 31, alone or after other attributes.
  expect(state(world).printed).not.toMatch(/\u001b\[(?:\d+;)*31m/);
});

Then('the printed report dims {string}', (world, text: string) => {
  expect(state(world).printed).toMatch(
    new RegExp(`\u001b\\[2m${escaped(text)}`)
  );
});

When('the summary {string} is split', (world, summary: string) => {
  state(world).split = splitSummary(summary);
});

Then(
  'its code is {string} and its detail is {string}',
  (world, code: string, detail: string) => {
    expect(state(world).split).toEqual({ code, detail });
  }
);
