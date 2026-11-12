import { expect } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommandWorld, commandSteps } from '../../support/command-steps';
import { steps } from '../../support/gherkin';
import type { Check, Status } from '../../../src/types';

export const ROOT = resolve(import.meta.dir, '../../..');

/** One scenario: a T3 home, what commands answer, and the checks reported. */
export class IdeWorld extends CommandWorld {
  private home: string | undefined;
  /** What the scenario's `When` produced besides checks. */
  result: unknown;
  /** A refusal a `Then` expects. */
  refusal: unknown;

  directory(prefix: string): string {
    // Resolved: T3 paths may not pass through a link, and on macOS the
    // temporary directory is reached through one.
    const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.defer(() => rmSync(path, { recursive: true, force: true }));
    return path;
  }

  get t3Home(): string {
    return (this.home ??= this.directory('ide-t3-'));
  }
}

export const ide = steps<IdeWorld>();
commandSteps(ide);
const { Then } = ide;

export const named = (world: IdeWorld, id: string): Check => {
  if (world.failure !== undefined) throw world.failure;
  const check = world.checks.find((candidate) => candidate.id === id);
  expect(check, `no check ${id}`).toBeDefined();
  return check!;
};

Then(
  /^the check "([^"]+)" (passes|warns|fails)$/,
  (world, id: string, verdict: string) => {
    expect(named(world, id).status).toBe(
      (
        { passes: 'pass', warns: 'warn', fails: 'fail' } as Record<
          string,
          Status
        >
      )[verdict]!
    );
  }
);

Then(
  /^the check "([^"]+)" (warns|fails) with "([^"]+)"$/,
  (world, id: string, verdict: string, summary: string) => {
    const check = named(world, id);
    expect(check.status).toBe(verdict === 'warns' ? 'warn' : 'fail');
    expect(check.summary).toBe(summary);
  }
);

Then(
  'the remedy of the check {string} mentions {string}',
  (world, id: string, text: string) => {
    expect(named(world, id).remedy?.action).toContain(text);
  }
);

Then('nothing reported contains {string}', (world, text: string) => {
  expect(JSON.stringify(world.checks)).not.toContain(text);
});

Then(/^the configuration is (accepted|refused)$/, (world, verdict: string) => {
  if (verdict === 'accepted') expect(world.refusal).toBeUndefined();
  else expect(world.refusal).toBeDefined();
});
