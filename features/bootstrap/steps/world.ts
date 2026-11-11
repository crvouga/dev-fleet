import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, steps } from '../../support/gherkin';

export class BootstrapWorld extends World {
  private failure: Error | undefined;
  private examined = false;
  /** The exit status of what the `When` ran. */
  exit: number | null | undefined;

  /** Runs what a `When` does. A refusal is kept for a `Then` to ask about. */
  async attempt(action: () => unknown): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.failure = error as Error;
    }
  }

  /** The refusal the `When` met, if any. */
  get refusal(): Error | undefined {
    this.examined = true;
    return this.failure;
  }

  /** A refusal no step asked about fails the scenario: it was not expected. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.failure && !this.examined) throw this.failure;
  }

  /** A new directory that is removed when the scenario ends. */
  directory(prefix: string): string {
    const created = mkdtempSync(join(tmpdir(), prefix));
    this.defer(() => rmSync(created, { recursive: true, force: true }));
    return created;
  }
}

/** What one group of steps keeps for a scenario, made when first asked for. */
export function part<T extends object>(
  create: (world: BootstrapWorld) => T
): (world: BootstrapWorld) => T {
  const parts = new WeakMap<BootstrapWorld, T>();
  return (world) => {
    let found = parts.get(world);
    if (!found) parts.set(world, (found = create(world)));
    return found;
  };
}

/** The lines of a doc string as the text of a file: each ends its line. */
export const lines = (text: string): string => `${text}\n`;

export const common = steps<BootstrapWorld>();
const { Then } = common;

Then('it is refused', (world) => {
  expect(world.refusal).toBeInstanceOf(Error);
});

Then('it is refused with {string}', (world, message: string) => {
  expect(world.refusal?.message).toContain(message);
});

Then('it is accepted', (world) => {
  expect(world.refusal).toBeUndefined();
});

Then('it exits with {int}', (world, status: number) => {
  expect(world.refusal).toBeUndefined();
  expect(world.exit).toBe(status);
});
