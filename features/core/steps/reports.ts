import { expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import { diagnostic } from '../../../src/diagnostics';
import { cleanCheck, decodeSnapshot, validCheck } from '../../../src/protocol';
import { makeReport, mapBounded, reportExitCode } from '../../../src/report';
import type { Check, Status } from '../../../src/types';
import { core, need, root, valueOf, type CoreWorld } from './world';

/** Reports, the protocol a worker answers in, diagnostics, and the one rule
 * about what this package may import.
 */
const { Given, When, Then } = core;

// ── Reports ──────────────────────────────────────────────────────────────

Given(
  'the worker {string} has these checks:',
  (world, node: string, table: DataTable) => {
    world.reports.push({ node, checks: table.hashes() as unknown as Check[] });
  }
);

When('the {string} report is made', (world, command: string) => {
  world.report = makeReport(command, world.reports);
});

const report = (world: CoreWorld) => need(world, world.report, 'a report');

Then('the report counts:', (world, table: DataTable) => {
  expect(report(world).summary).toEqual(
    Object.fromEntries(
      Object.entries(table.rowsHash()).map(([status, count]) => [
        status,
        Number(count),
      ])
    ) as Record<Status, number>
  );
});

Then(
  /^(the|a strict) run exits with (\d+)$/,
  (world, kind: string, code: number) => {
    expect(reportExitCode(report(world), kind === 'a strict')).toBe(
      Number(code)
    );
  }
);

const numbers = (table: DataTable): number[] => table.raw()[0]!.map(Number);

Given(
  'probes of workers that take these milliseconds:',
  (world, table: DataTable) => {
    world.durations = numbers(table);
  }
);

When(
  'they are run {int} at a time, each answering twice its milliseconds',
  async (world, concurrency: number) => {
    let active = 0;
    world.answers = await mapBounded(
      world.durations,
      async (milliseconds) => {
        active += 1;
        world.atOnce = Math.max(world.atOnce, active);
        await Bun.sleep(milliseconds);
        active -= 1;
        return milliseconds * 2;
      },
      concurrency
    );
  }
);

Then('the answers are, in this order:', (world, table: DataTable) => {
  expect(world.answers).toEqual(numbers(table));
});

Then('the most that ran at once was {int}', (world, count: number) => {
  expect(world.atOnce).toBe(count);
});

// ── The protocol ─────────────────────────────────────────────────────────

When(
  'the manager decodes this snapshot from a worker:',
  (world, document: string) => {
    world.snapshot = decodeSnapshot(document);
    world.outcome = world.snapshot;
  }
);

Then('the snapshot is accepted, with the version {int}', (world, version) => {
  expect(world.snapshot?.version).toBe(version);
});

// ── Diagnostics ──────────────────────────────────────────────────────────

Given('the check:', (world, table: DataTable) => {
  const { id, status, summary, remedy, ...others } = table.rowsHash();
  world.check = {
    id,
    status,
    summary,
    ...(remedy === undefined ? {} : { remedy: { action: remedy } }),
    ...Object.fromEntries(
      Object.entries(others).map(([field, cell]) => [field, valueOf(cell)])
    ),
  };
});

const check = (world: CoreWorld): Check =>
  need(world, world.check, 'a check') as unknown as Check;

When(
  'the diagnostic of that check on {string} is made',
  (world, node: string) => {
    world.diagnostic = diagnostic(node, check(world));
  }
);

When(
  'that check arrives from {string} over the protocol',
  (world, node: string) => {
    world.accepted = validCheck(check(world));
    if (!world.accepted) return;
    const cleaned = cleanCheck(check(world));
    world.outcome = cleaned;
    world.diagnostic = diagnostic(node, cleaned);
  }
);

Then(
  /^the protocol (accepts|does not accept) the check$/,
  (world, verdict: string) => {
    expect(need(world, world.accepted, 'a verdict')).toBe(
      verdict === 'accepts'
    );
  }
);

Then('the diagnostic says:', (world, table: DataTable) => {
  expect(need(world, world.diagnostic, 'a diagnostic')).toMatchObject(
    Object.fromEntries(
      Object.entries(table.rowsHash()).map(([field, cell]) => [
        field,
        valueOf(cell),
      ])
    )
  );
});

Then(
  'the remedy of the diagnostic belongs to {string}',
  (world, owner: string) => {
    expect(need(world, world.diagnostic, 'a diagnostic').remedy.owner).toBe(
      owner
    );
  }
);

// ── Layering ─────────────────────────────────────────────────────────────

/** Every TypeScript source of the checkout that is not a test. */
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      found.push(path);
  }
  return found;
}

When(
  'every source file is searched for imports from these sibling packages:',
  async (world, table: DataTable) => {
    const imports = new RegExp(
      `(?:from|import)\\s*\\(?\\s*['"]((?:\\.\\.\\/)+)(${table.list().join('|')})\\/`,
      'g'
    );
    for (const file of await sources(root)) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(imports))
        world.found.push(`${relative(root, file)} -> ${match[2]}`);
    }
  }
);

Then('no such import is found', (world) => {
  expect(world.found).toEqual([]);
});
