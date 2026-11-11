import { expect } from 'bun:test';
import { fingerprint } from '../../../src/fingerprint';
import { probe } from '../../../src/probe';
import { recipe, type AutomatedRepair } from '../../../src/repair-catalog';
import { automaticRepairs, repairPlan } from '../../../src/repair-plan';
import { repairWorkspace, validRepairs } from '../../../src/repair-runner';
import { runCommand } from '../../../src/runner';
import { inspectRemote } from '../../../src/transport';
import type { DataTable } from '../../support/gherkin';
import { bundledProbe } from '../support/probe';
import {
  checksIn,
  list,
  need,
  orchestration,
  type OrchestrationWorld,
} from '../support/world';

const { Given, When, Then } = orchestration;

// ── The plan ─────────────────────────────────────────────────────────────

Given(
  'the computer under repair reported these checks:',
  (world, table: DataTable) => {
    world.repair.reported = checksIn(table);
  }
);

Given(
  'the computer is {string}, whose checkout was probed and can be repaired',
  async (world, name: string) => {
    const root = need(world.root, 'a checkout');
    world.repair.node = name;
    world.repair.snapshot = await probe(root, [], world.run);
    world.repair.targets = [{ name, root }];
  }
);

Given(
  'the computer is {string}, which could not be probed',
  (world, name: string) => {
    world.repair.node = name;
  }
);

When('the repair plan is drawn up', (world) => {
  const { snapshot, reported, targets } = world.repair;
  world.repair.steps = repairPlan(
    [
      {
        node: need(world.repair.node, 'a computer under repair'),
        checks: reported,
        ...(snapshot ? { snapshot } : {}),
      },
    ],
    targets
  );
  world.outcome = world.repair.steps;
});

const step = (world: OrchestrationWorld, id: string) =>
  need(
    world.repair.steps.find((entry) => entry.id === id),
    `a step "${id}" in the plan`
  );

Then('every check that did not pass belongs to exactly one step', (world) => {
  const unresolved = world.repair.reported
    .filter((check) => check.status !== 'pass')
    .map((check) => check.id);
  expect(unresolved.length).toBeGreaterThan(0);
  expect(world.repair.steps.flatMap((entry) => entry.checks).sort()).toEqual(
    unresolved.sort()
  );
});

Then(
  'the step {string} covers {int} check(s)',
  (world, id: string, count: number) => {
    expect(step(world, id).checks).toHaveLength(count);
  }
);

Then('only these steps are automatic, in order:', (world, table: DataTable) => {
  expect(
    world.repair.steps
      .filter((entry) => entry.automatic)
      .map((entry) => entry.id)
  ).toEqual(table.list());
});

Then('{string} is in no command of any step', (world, text: string) => {
  expect(world.repair.steps.length).toBeGreaterThan(0);
  expect(
    JSON.stringify(world.repair.steps.map((entry) => entry.commands))
  ).not.toContain(text);
});

Then('no step is eligible', (world) => {
  expect(world.repair.steps.length).toBeGreaterThan(0);
  expect(world.repair.steps.every((entry) => !entry.eligible)).toBe(true);
});

Then(
  'the automatic repairs of {string} are, in order:',
  (world, node: string, table: DataTable) => {
    expect(
      automaticRepairs(world.repair.steps, node).map((entry) => entry.id)
    ).toEqual(table.list());
  }
);

// ── Applying repairs to a checkout ───────────────────────────────────────

When(
  /^the repairs "([^"]+)" are applied to the checkout( against the reference fingerprint)?$/,
  async (world, repairs: string, againstReference: string | undefined) => {
    world.checks = await repairWorkspace(
      need(world.root, 'a checkout'),
      list(repairs) as AutomatedRepair[],
      world.run,
      againstReference
        ? need(world.reference, 'a reference fingerprint')
        : undefined
    );
    world.outcome = world.checks;
  }
);

Then(
  'besides git, only the {string} command of the repair catalog was run:',
  (world, id: string, line: string) => {
    const command = need(
      recipe(id).commands[0],
      `a command for "${id}" in the repair catalog`
    );
    expect(command.join(' ')).toBe(line);
    expect(
      world.commands.calls
        .map((call) => call.command)
        .filter((ran) => ran[0] !== 'git')
    ).toEqual([command]);
  }
);

When(/^a worker is asked for the repairs (.+)$/, (world, request: string) => {
  world.verdict = validRepairs(JSON.parse(request));
});

Then('the repair request is refused', (world) => {
  expect(world.verdict).toBe(false);
});

// ── The request a worker receives ────────────────────────────────────────

When(
  /^the bundled probe is asked to repair with "apply" (true|false), the repairs (.+) and (the fingerprint of the checkout|no fingerprint)$/,
  async (world, apply: string, repairs: string, expected: string) => {
    const root = need(world.root, 'a checkout');
    const request = {
      action: 'repair',
      node: need(world.nodes[0], 'a worker'),
      apply: apply === 'true',
      repairs: JSON.parse(repairs) as unknown,
      expected:
        expected === 'no fingerprint'
          ? null
          : await fingerprint(root, world.run),
    };
    // As the manager's SSH command starts it: the probe on standard input,
    // the request as its one argument.
    world.process = await runCommand(
      [
        'node',
        '--input-type=module',
        '-',
        Buffer.from(JSON.stringify(request)).toString('base64'),
      ],
      { cwd: root, input: await bundledProbe() }
    );
  }
);

Then(
  'it prints a version {int} document that carries an error',
  (world, version: number) => {
    expect(JSON.parse(need(world.process, 'a process').stdout)).toMatchObject({
      version,
      error: expect.any(String),
    });
  }
);

/** How long the manager would wait for the worker; the answer is immediate. */
const REPAIR_TIMEOUT_MS = 1000;

When(
  'the manager asks the worker to apply the repairs {string} against the reference fingerprint',
  async (world, repairs: string) => {
    const report = await inspectRemote(
      need(world.nodes[0], 'a worker'),
      {
        action: 'repair',
        source: need(world.probe.source, 'a probe source'),
        timeoutMs: REPAIR_TIMEOUT_MS,
        repairs: list(repairs) as AutomatedRepair[],
        expected: need(world.reference, 'a reference fingerprint'),
      },
      world.run
    );
    world.checks = report.checks;
    world.outcome = report;
  }
);
