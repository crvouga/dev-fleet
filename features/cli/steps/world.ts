import { expect } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, steps } from '../../support/gherkin';
import type { CommandOutcome } from '../../../src/cli/contracts';
import type { Release } from '../../../src/cli/program';
import type { Settings } from '../../../src/cli/settings';
import type { Roster } from '../../../src/t3/accounts';

/** The state of one scenario of the CLI. What only one group of steps needs
 * is kept beside those steps, with `part`.
 */
export class CliWorld extends World {
  /** What `$NAME` stands for in a command line or a path of this scenario. */
  readonly names: Record<string, string> = {};
  release: Release = { version: 'test', releasedAt: null };
  /** The workspace and roster devfleet is run with. */
  where: Settings | undefined;
  /** What the command of the `When` step exited with and answered. */
  outcome: CommandOutcome | undefined;
  /** What the `When` step was refused with. A scenario that never looks at
   * it fails: a refusal nobody expected is a defect.
   */
  failure: unknown;
  examined = false;
  /** The roster file as it read before the `When` step. */
  rosterBefore: string | null = null;
  /** Set once a scenario describes this machine's tools: devfleet then runs
   * against those stand-ins instead of starting anything.
   */
  standIn: ((args: string[]) => Promise<CommandOutcome>) | undefined;
  /** The accounts signed in on the CLI proxy, when a scenario names them. */
  proxy: Roster | undefined;

  constructor() {
    super();
    // Registered first, so it runs after everything else is undone.
    this.defer(() => {
      if (this.failure === undefined || this.examined) return;
      throw new Error(
        `The When step was refused and no Then step expected it: ${
          this.failure instanceof Error
            ? this.failure.message
            : String(this.failure)
        }`,
        { cause: this.failure }
      );
    });
  }
}

export const cli = steps<CliWorld>();

/** The CLI proxy is never asked: a scenario says who is signed in on it. */
export function proxy(world: CliWorld): Roster {
  return (
    world.proxy ??
    (async () => {
      throw new Error(
        'The scenario does not say who is signed in on the CLI proxy.'
      );
    })
  );
}

/** State that one file of steps keeps for a scenario. */
export function part<T>(
  create: (world: CliWorld) => T
): (world: CliWorld) => T {
  const parts = new WeakMap<CliWorld, T>();
  return (world) => {
    if (!parts.has(world)) parts.set(world, create(world));
    return parts.get(world)!;
  };
}

/** Runs what a `When` step does, keeping a refusal for a `Then` to examine. */
export async function attempt<T>(
  world: CliWorld,
  action: () => T | Promise<T>
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    world.failure = error ?? new Error('Refused without a reason.');
    return undefined;
  }
}

/** The refusal of the `When` step, which the scenario now expects. */
export function refusal(world: CliWorld): unknown {
  world.examined = true;
  return world.failure;
}

export function outcome(world: CliWorld): CommandOutcome {
  if (!world.outcome) throw new Error('No command has answered.');
  return world.outcome;
}

export function where(world: CliWorld): Settings {
  if (!world.where)
    throw new Error('The scenario does not say where devfleet runs.');
  return world.where;
}

/** A directory that is removed after the scenario. */
export async function temporary(
  world: CliWorld,
  prefix: string
): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  world.defer(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** `$NAME` replaced by what the scenario calls NAME. */
export function expand(world: CliWorld, text: string): string {
  return text.replace(/\$([A-Z][A-Z0-9_]*)/g, (_, name: string) => {
    const value = world.names[name];
    if (value === undefined)
      throw new Error(`The scenario does not say what $${name} is.`);
    return value;
  });
}

/** The arguments of a command line written as an operator types it. */
export function argv(world: CliWorld, line: string): string[] {
  const [program, ...args] = line.trim().split(/\s+/);
  if (program !== 'devfleet')
    throw new Error(`Not a devfleet command line: ${line}`);
  return args.map((arg) => expand(world, arg));
}

/** A list written in a step: "one, two". */
export function listed(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The value at a dotted path: `agent.support.issues`, `nodes.0.id`. */
export function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** Sets the value at a dotted path of a JSON document. */
export function put(document: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = at(document, keys.join('.'));
  if (keys.length === 0) (document as Record<string, unknown>)[last] = value;
  else if (parent !== null && typeof parent === 'object')
    (parent as Record<string, unknown>)[last] = value;
  else throw new Error(`Nothing is at ${keys.join('.')}.`);
}

export function json(text: string): unknown {
  return JSON.parse(text);
}

/** A JSON document from a feature, where a string written "…text…" stands
 * for any string that contains the text.
 */
export function pattern(value: unknown): unknown {
  if (typeof value === 'string') {
    const inner = /^…(.*)…$/s.exec(value)?.[1];
    return inner === undefined ? value : expect.stringContaining(inner);
  }
  if (Array.isArray(value)) return value.map(pattern);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, pattern(item)])
    );
  return value;
}

export const SHA256 = /^[a-f0-9]{64}$/;
