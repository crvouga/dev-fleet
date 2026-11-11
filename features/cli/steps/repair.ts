import { expect } from 'bun:test';
import { repairScript, targetCommand } from '../../../src/cli/repair-script';
import { probe } from '../../../src/probe';
import { repairPlan, type RepairTarget } from '../../../src/repair-plan';
import { runCommand } from '../../../src/runner';
import type { Check, NodeReport } from '../../../src/types';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { cli, outcome, part, where, type CliWorld } from './world';

const { Given, When, Then } = cli;

const repair = part(() => ({
  reports: [] as NodeReport[],
  targets: [] as RepairTarget[],
  script: undefined as string | undefined,
  argument: '',
  printed: '',
}));

interface Step {
  id: string;
  node: string;
  automatic: boolean;
  eligible: boolean;
}
const planned = (world: CliWorld): Step[] =>
  (outcome(world).data as { steps: Step[] }).steps;
const stepsFor = (world: CliWorld, node: string): Step[] =>
  planned(world).filter((step) => step.node === node);

/** The script a scenario wrote, or the one the command answered with. */
const script = (world: CliWorld): string =>
  repair(world).script ?? (outcome(world).data as { script: string }).script;

// ── The plan ─────────────────────────────────────────────────────────────

Then('the repair step {string} is not automatic', (world, id: string) => {
  expect(planned(world).find((step) => step.id === id)?.automatic).toBe(false);
});

Then('there are repair steps for {string}', (world, node: string) => {
  expect(stepsFor(world, node).length).toBeGreaterThan(0);
});

Then(
  'none of the repair steps for {string} is eligible',
  (world, node: string) => {
    expect(stepsFor(world, node).every((step) => !step.eligible)).toBe(true);
  }
);

// ── The script ───────────────────────────────────────────────────────────

Given(
  'the machine {string}, probed in this workspace at the commit {string}, has these checks:',
  async (world, node: string, commit: string, table: DataTable) => {
    const root = where(world).workspace;
    const snapshot = await probe(root, [], async (command) =>
      succeeded(command.includes('rev-parse') ? commit : '')
    );
    repair(world).reports.push({
      node,
      snapshot,
      checks: table.hashes() as unknown as Check[],
    });
    repair(world).targets.push({ name: node, root });
  }
);

When('the repair script is written', (world) => {
  const state = repair(world);
  state.script = repairScript(
    repairPlan(state.reports, state.targets),
    state.targets
  );
});

Then('the script contains {string}', (world, part: string) => {
  expect(script(world)).toContain(part);
});

Then('the script does not contain {string}', (world, part: string) => {
  expect(script(world)).not.toContain(part);
});

Then(
  'every line of the script that contains {string} is a comment',
  (world, part: string) => {
    expect(
      script(world)
        .split('\n')
        .filter((line) => line.includes(part))
        .every((line) => line.startsWith('# '))
    ).toBe(true);
  }
);

Then('the script is valid POSIX shell', async (world) => {
  expect((await runCommand(['sh', '-n'], { input: script(world) })).ok).toBe(
    true
  );
});

// ── A generated command ──────────────────────────────────────────────────

When(
  'a shell runs the command generated for the workspace from {string} and this argument:',
  async (world, command: string, argument: string) => {
    const state = repair(world);
    state.argument = argument;
    state.printed = (
      await runCommand([
        'sh',
        '-c',
        targetCommand({ name: 'local', root: where(world).workspace }, [
          [...command.split(' '), argument],
        ]),
      ])
    ).stdout;
  }
);

Then('it prints exactly that argument', (world) => {
  expect(repair(world).printed).toBe(repair(world).argument);
});
