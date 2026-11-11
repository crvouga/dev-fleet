import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { World, steps } from '../../support/gherkin';
import { Commands } from '../../support/commands';
import type { FleetDefinition } from '../../../src/definition';
import type { Diagnostic } from '../../../src/diagnostics';
import type { SecretsConfig } from '../../../src/secrets';
import type { Tailnet } from '../../../src/tailscale';
import type {
  Check,
  CommandResult,
  FleetConfig,
  FleetNode,
  NodeReport,
  Report,
  Snapshot,
} from '../../../src/types';

/** The checkout these features describe. */
export const root = resolve(import.meta.dir, '../../..');

/** A roster as it is written, before anything has judged it. */
export interface WrittenRoster {
  version: unknown;
  nodes: Record<string, unknown>[];
  [field: string]: unknown;
}

export class CoreWorld extends World {
  /** Stands in for every subprocess; a scenario says what each one answers. */
  readonly commands = new Commands();

  // What the one When of a scenario left behind.
  /** What a report would show: the thing `nothing reported contains` reads. */
  outcome: unknown;
  checks: Check[] = [];
  /** Why the When was refused, when it was. */
  failure: Error | undefined;
  text: string | undefined;
  argv: string[] | undefined;
  result: CommandResult | undefined;

  // The fleet configuration, the roster and one worker.
  written: Record<string, unknown> | undefined;
  definition: FleetDefinition | undefined;
  roster: WrittenRoster | undefined;
  config: FleetConfig | undefined;
  selected: FleetNode[] | undefined;
  node: FleetNode | undefined;

  // Secrets.
  secrets: SecretsConfig | undefined;
  secretsDirectory: string | undefined;
  environment: Record<string, string> = {};
  secret: string | null | undefined;
  secretsBlock: { written: unknown; read: SecretsConfig | null } | undefined;

  // The tailnet.
  tailscale: Record<string, unknown> | undefined;
  tailnet: Tailnet | undefined;
  matches: Map<string, FleetNode[]> | undefined;

  // T3.
  /** The time on the manager, when a scenario stops its clock. */
  clock: number | undefined;
  reconnect: { withinMs: number; everyMs: number } | undefined;
  waitedMs = 0;
  respond: (() => Response) | undefined;
  requests: { url: string; options: RequestInit }[] = [];

  // A checkout.
  checkout: string | undefined;
  revision = '';

  // The operation lock.
  lock: { path: string; shell: ChildProcess; installer: number } | undefined;

  // Reports and diagnostics.
  reports: NodeReport[] = [];
  report: Report | undefined;
  durations: number[] = [];
  answers: number[] = [];
  atOnce = 0;
  snapshot: Snapshot | null | undefined;
  check: Record<string, unknown> | undefined;
  accepted: boolean | undefined;
  diagnostic: Diagnostic | undefined;

  /** What the search of the sources found. */
  found: string[] = [];
}

/** Every step of this area, whichever file defines it. */
export const core = steps<CoreWorld>();

/** A feature writes a character that cannot be seen as its control picture:
 * ␊ is a line break, ␀ a NUL byte, ␠ a space.
 */
export const control = (text: string): string =>
  text.replace(/[␀-␠]/g, (picture) =>
    String.fromCharCode(picture.charCodeAt(0) - 0x2400)
  );

/** Runs the When of a scenario that may be refused, and keeps the refusal. */
export async function attempt(
  world: CoreWorld,
  action: () => unknown
): Promise<void> {
  try {
    await action();
  } catch (error) {
    world.failure = error as Error;
  }
}

/** What an earlier step left, or the reason there is nothing: a When that was
 * refused fails the Then that expected its result.
 */
export function need<T>(
  world: CoreWorld,
  value: T | undefined,
  what: string
): T {
  if (world.failure) throw world.failure;
  if (value === undefined) throw new Error(`No step has left ${what} yet.`);
  return value;
}

/** A cell that is JSON is that value; any other cell is its text. */
export function valueOf(cell: string): unknown {
  if (cell === 'Infinity') return Infinity;
  try {
    return JSON.parse(cell);
  } catch {
    return cell;
  }
}

/** Matches a command by its first words: "git status" is any `git status …`. */
export const startsWith = (line: string) => {
  const words = line.split(' ');
  return (command: string[]): boolean =>
    words.every((word, index) => command[index] === word);
};
