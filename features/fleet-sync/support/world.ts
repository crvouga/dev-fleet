import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CommandOutcome } from '../../../src/cli/contracts';
import type { FleetSyncOptions } from '../../../src/cli/fleet-sync';
import type { ForwardSpawn } from '../../../src/cli/fleet-sync-forward';
import type { CliOptions } from '../../../src/cli/options';
import type { Settings } from '../../../src/cli/settings';
import { loadDefinition } from '../../../src/definition';
import type { Tailnet } from '../../../src/tailscale';
import type {
  Capability,
  Check,
  FleetNode,
  NodeReport,
} from '../../../src/types';
import { Commands } from '../../support/commands';
import { World, steps, type DataTable } from '../../support/gherkin';

/** The checkout these features run in. */
export const ROOT = resolve(import.meta.dir, '../../..');

/** The example fleet: the configuration every scenario runs against. */
export const definition = loadDefinition(resolve(ROOT, 'examples/fleet.json'));

/** A hub that answers from memory: what it is told to be, and what it was sent. */
export interface Hub {
  version: string;
  key: string;
  userId: string;
  /** The one system a lookup by name answers with; none when null. */
  system: { id: string; status: string } | null;
}

export class FleetSyncWorld extends World {
  /** Stands in for every subprocess. */
  readonly commands = new Commands();
  /** What a scenario said must not happen, and happened. */
  readonly violations: string[] = [];

  settings: Settings = { workspace: '/no-checkout', config: '/no-roster' };
  version = '0.1.0';
  /** What the command under test returned; null when it returned nothing. */
  outcome: CommandOutcome | null | undefined;
  /** What the step under test threw. */
  failure: Error | undefined;
  checks: Check[] = [];
  /** The roster entry a scenario is about. */
  node: FleetNode | undefined;
  roster: FleetNode[] = [];
  /** An SSH command line a step prepared. */
  command: string[] = [];
  /** A value a `When` produced, for the `Then` that names it. */
  answer: unknown;

  // The hand-off and the run from a checkout.
  script: string | null = null;
  spawn: ForwardSpawn | undefined;
  spawned: string[][] = [];
  forwarded: string[] = [];
  /** The manager's own caches, made when a scenario first needs them. */
  caches: string | undefined;
  shipped: { revision: string | null; root: string } | undefined;

  // The tailnet and the hub.
  tailnet: Tailnet = { computers: [], excludedMobile: 0, checks: [] };
  hub: Hub | undefined;
  hubLogin: (() => never) | undefined;
  hubLogins: string[] = [];
  hubRecords: object[] = [];
  reports: NodeReport[] = [];
  dashboard: string | null | undefined;

  constructor() {
    super();
    // Registered first, so it runs last: after everything else is undone.
    this.defer(() => {
      if (this.violations.length > 0)
        throw new Error(
          `The scenario did what it said must not happen: ${this.violations.join(', ')}`
        );
    });
  }
}

export const fleetSync = steps<FleetSyncWorld>();

/** Something a scenario says must not happen. Calling it fails the step it
 * happens in, and the scenario even when that failure is swallowed.
 */
export function forbid(world: FleetSyncWorld, what: string): () => never {
  return () => {
    world.violations.push(what);
    throw new Error(`must not ${what}`);
  };
}

/** A directory that is gone after the scenario. Its real path: the run lock
 * refuses a path through a symbolic link, as /tmp is on macOS.
 */
export function temporary(world: FleetSyncWorld, prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  world.defer(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Sets (or, with undefined, unsets) a variable until the scenario ends. */
export function setEnv(
  world: FleetSyncWorld,
  name: string,
  value: string | undefined
): void {
  const before = process.env[name];
  world.defer(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const VALUE_FLAGS = new Set(['revision', 'schedule', 'require', 'timeout']);
const camel = (flag: string): string =>
  flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** The options a command line of flags asks for: `--node w1 --dry-run` is
 * `{ node: ['w1'], dryRun: true }`.
 */
export function flags(text: string): FleetSyncOptions & CliOptions {
  const words = text.split(' ').filter(Boolean);
  const options: Record<string, unknown> = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!word.startsWith('--')) throw new Error(`Not a flag: ${word}`);
    const key = camel(word.slice(2));
    if (key === 'node')
      options[key] = [...((options[key] as string[]) ?? []), words[++index]!];
    else if (VALUE_FLAGS.has(key)) options[key] = words[++index]!;
    else options[key] = true;
  }
  return options;
}

/** `fleet-sync --json` is the request `{ json: true }`. */
export function request(command: string): FleetSyncOptions {
  const [name, ...rest] = command.split(' ');
  if (name !== 'fleet-sync') throw new Error(`Not fleet-sync: ${command}`);
  return flags(rest.join(' '));
}

/** A cell as the value it writes: `2`, `true` and `null` are JSON, anything
 * else is the text itself.
 */
export function literal(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A table of `path | value` rows as one object: `coverage.computers | 2`. */
export function nested(table: DataTable): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(table.rowsHash())) {
    const keys = path.split('.');
    let target = result;
    for (const key of keys.slice(0, -1))
      target = (target[key] ??= {}) as Record<string, unknown>;
    target[keys.at(-1)!] = literal(value);
  }
  return result;
}

/** A row of a roster table: an empty cell is a field the entry does not have. */
export function rosterEntry(row: Record<string, string>): FleetNode {
  return {
    id: row['id'] ?? '',
    ssh: row['ssh'] ?? '',
    workspace: row['workspace'] ?? '',
    ...(row['runtime'] ? { runtime: row['runtime'] } : {}),
    required: (row['required'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) as Capability[],
    ...(row['bootstrapViaSsh']
      ? { bootstrapViaSsh: row['bootstrapViaSsh'] === 'true' }
      : {}),
    ...(row['tailscaleId'] ? { tailscaleId: row['tailscaleId'] } : {}),
  };
}

/** A row of a table of checks: `check | status | summary | remedy`. */
export function checkFrom(row: Record<string, string>): Check {
  return {
    id: row['check'] ?? '',
    status: (row['status'] ?? 'pass') as Check['status'],
    summary: row['summary'] ?? '',
    ...(row['remedy'] ? { remedy: { action: row['remedy'] } } : {}),
  };
}

export const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
