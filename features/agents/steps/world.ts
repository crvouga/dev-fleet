import { expect } from 'bun:test';
import { World, steps } from '../../support/gherkin';

export class AgentsWorld extends World {
  private failure: Error | undefined;
  private examined = false;

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
}

/** What one group of steps keeps for a scenario, made when first asked for. */
export function part<T extends object>(
  create: (world: AgentsWorld) => T
): (world: AgentsWorld) => T {
  const parts = new WeakMap<AgentsWorld, T>();
  return (world) => {
    let found = parts.get(world);
    if (!found) parts.set(world, (found = create(world)));
    return found;
  };
}

export const common = steps<AgentsWorld>();
const { Then } = common;

Then('it is refused', (world) => {
  expect(world.refusal).toBeInstanceOf(Error);
});

Then('it is refused with {string}', (world, message: string) => {
  expect(world.refusal?.message).toContain(message);
});
