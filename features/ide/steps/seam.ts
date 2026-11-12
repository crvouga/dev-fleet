import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import type { Ide } from '../../../src/ide/ide';
import { IDES } from '../../../src/ide';
import {
  enabled,
  managerChecks,
  workerChecks,
} from '../../../src/ide/orchestrate';
import { idesOf } from '../../../src/ide/definition';
import { parseDefinition } from '../../../src/definition';
import type { Check } from '../../../src/types';
import { ide, ROOT, type IdeWorld } from './world';

const { Given, When, Then } = ide;

interface Seam {
  registry: Record<string, Ide>;
  told: Check[];
  ides: string[];
  sources: string[];
}
const seam = new WeakMap<IdeWorld, Seam>();
const of = (world: IdeWorld): Seam => {
  let value = seam.get(world);
  if (!value)
    seam.set(
      world,
      (value = { registry: {}, told: [], ides: [], sources: [] })
    );
  return value;
};

const pass = (id: string): Check => ({ id, status: 'pass', summary: id });

Given(
  'a second IDE {string} whose checks are {string}, {string} and {string}',
  (world, id: string, settings: string, manager: string, worker: string) => {
    const state = of(world);
    state.registry[id] = {
      id,
      settings: async () => [pass(settings)],
      manager: async () => [pass(manager)],
      worker: async (_node, context) => {
        state.told.push(...context.earlier);
        return [pass(worker)];
      },
    };
  }
);

const node = {
  id: 'worker-one',
  ssh: 'worker-one',
  workspace: '/w',
  required: [],
};

When(
  'the fleet enables only {string} and converges the manager and one worker',
  async (world, id: string) => {
    const ides = enabled([id], of(world).registry);
    const context = {
      id: 'manager',
      workspace: ROOT,
      apply: true,
      run: world.run,
    };
    world.checks = [
      ...(await managerChecks(ides, context)),
      ...(await workerChecks(ides, node, {
        run: world.run,
        workspace: ROOT,
        earlier: [],
      })),
    ];
  }
);

When(
  'the fleet enables only {string} and converges one worker that already reported {string}',
  async (world, id: string, earlier: string) => {
    world.checks = await workerChecks(enabled([id], of(world).registry), node, {
      run: world.run,
      workspace: ROOT,
      earlier: [pass(earlier)],
    });
  }
);

Then('these checks were reported:', (world, table: DataTable) => {
  expect(world.checks.map((check) => check.id)).toEqual(
    table.hashes().map((row) => row['check']!)
  );
});

Then('no check was reported by T3', (world) => {
  expect(world.checks.filter((check) => check.id.startsWith('t3:'))).toEqual(
    []
  );
});

Then(
  'the IDE {string} was told of the earlier check {string}',
  (world, _id: string, check: string) => {
    expect(of(world).told.map((told) => told.id)).toContain(check);
  }
);

When('the interface and orchestration sources are read', (world) => {
  of(world).sources = ['src/ide/ide.ts', 'src/ide/orchestrate.ts'].map((path) =>
    readFileSync(join(ROOT, path), 'utf8')
  );
});

Then('neither mentions {string}', (world, word: string) => {
  for (const source of of(world).sources)
    expect(source.toLowerCase()).not.toContain(word.toLowerCase());
});

When('the example fleet configuration is read', (world) => {
  const definition = parseDefinition(
    JSON.parse(readFileSync(join(ROOT, 'examples/fleet.json'), 'utf8'))
  );
  of(world).ides = idesOf(definition);
});

Then('the fleet runs these IDEs:', (world, table: DataTable) => {
  expect(of(world).ides).toEqual(table.hashes().map((row) => row['ide']!));
});

Then('the IDE {string} is implemented', (_world, id: string) => {
  expect(enabled([id], IDES).map((found) => found.id)).toEqual([id]);
});

/** The example fleet with one top-level key changed. */
export function readWith(world: IdeWorld, key: string, value: unknown): void {
  const example = JSON.parse(
    readFileSync(join(ROOT, 'examples/fleet.json'), 'utf8')
  ) as Record<string, unknown>;
  try {
    parseDefinition({ ...example, [key]: value });
  } catch (error) {
    world.refusal = error;
  }
}

When(
  /^a fleet configuration that sets ides to (.+) is read$/,
  (world, ides: string) => {
    readWith(world, 'ides', JSON.parse(ides));
  }
);
