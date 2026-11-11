import { expect } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../../../src/cli/program';
import type { CommandOutcome } from '../../../src/cli/contracts';
import { workspace } from '../../support/fixtures';
import {
  SHA256,
  argv,
  at,
  attempt,
  cli,
  json,
  outcome,
  refusal,
  temporary,
  where,
  type CliWorld,
} from './world';

const { Given, When, Then } = cli;

// ── Where devfleet runs ──────────────────────────────────────────────────

Given(
  /^devfleet at version "([^"]+)"(?:, released at "([^"]+)")?(?:, with its issue tracker at "([^"]+)")?$/,
  (world, version: string, releasedAt?: string, issues?: string) => {
    world.release = {
      version,
      releasedAt: releasedAt ?? null,
      ...(issues ? { issues } : {}),
    };
  }
);

Given('a project with no roster', async (world) => {
  const project = await temporary(world, 'personal-cli-test-');
  world.names['PROJECT'] = project;
  world.where = { workspace: project, config: join(project, 'fleet.json') };
});

Given('a workspace with its dependency files and no roster', async (world) => {
  const root = await workspace();
  world.defer(() => rm(root, { recursive: true, force: true }));
  world.names['WORKSPACE'] = root;
  world.where = { workspace: root, config: join(root, 'fleet.json') };
});

Given(
  'devfleet runs from {string} with the roster {string}',
  (world, checkout: string, roster: string) => {
    world.where = { workspace: checkout, config: roster };
  }
);

// ── Running a command ────────────────────────────────────────────────────

async function text(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** One devfleet command line. It runs the whole program, unless the scenario
 * described this machine's tools: then it runs against those stand-ins.
 */
export async function run(
  world: CliWorld,
  line: string
): Promise<CommandOutcome> {
  const args = argv(world, line);
  return world.standIn
    ? world.standIn(args)
    : execute(args, where(world), world.release);
}

Given('the operator has run {string}', async (world, line: string) => {
  const done = await run(world, line);
  if (done.exitCode !== 0)
    throw new Error(`"${line}" exited with ${done.exitCode}.`);
});

When('the operator runs {string}', async (world, line: string) => {
  world.rosterBefore = await text(where(world).config);
  world.outcome = await attempt(world, () => run(world, line));
});

// ── What it exits with, prints and answers ───────────────────────────────

Then('it exits with {int}', (world, code: number) => {
  expect(outcome(world).exitCode).toBe(code);
});

Then('it answers with a document', (world) => {
  expect(outcome(world).data).toBeObject();
});

Then('it answers with at least:', (world, document: string) => {
  expect(outcome(world).data).toMatchObject(
    json(document) as Record<string, unknown>
  );
});

Then(
  /^in the answer, "([^"]+)" is (.+)$/,
  (world, path: string, value: string) => {
    expect(at(outcome(world).data, path)).toEqual(json(value));
  }
);

Then(
  'in the answer, {string} contains {string}',
  (world, path: string, part: string) => {
    expect(at(outcome(world).data, path)).toContain(part);
  }
);

Then('in the answer, {string} holds a list', (world, path: string) => {
  expect(at(outcome(world).data, path)).toBeArray();
});

Then(
  'in the answer, {string} holds a SHA-256 digest',
  (world, path: string) => {
    expect(at(outcome(world).data, path)).toMatch(SHA256);
  }
);

Then('the answer contains {string}', (world, part: string) => {
  expect(JSON.stringify(outcome(world).data)).toContain(part);
});

Then('nothing it answers contains {string}', (world, part: string) => {
  expect(JSON.stringify(outcome(world))).not.toContain(part);
});

Then('it prints exactly {string}', (world, expected: string) => {
  expect(outcome(world).text).toBe(expected);
});

Then('it prints text containing {string}', (world, part: string) => {
  expect(outcome(world).text).toContain(part);
});

Then('it does not print {string}', (world, part: string) => {
  expect(outcome(world).text).not.toContain(part);
});

Then('it prints what {string} prints', async (world, line: string) => {
  expect(outcome(world).text).toBe((await run(world, line)).text!);
});

Then('it answers what {string} answers', async (world, line: string) => {
  expect(outcome(world).data).toEqual((await run(world, line)).data);
});

// ── Being refused ────────────────────────────────────────────────────────

Then('it is refused', (world) => {
  expect(refusal(world)).toBeDefined();
});

Then('it is refused with {string}', (world, reason: string) => {
  const failure = refusal(world);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(reason);
});

Then('it is not refused', (world) => {
  expect(world.failure).toBeUndefined();
});
