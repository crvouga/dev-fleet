import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reloadFleet } from '../../../src/fleet-config';
import type { Bucket } from '../../../src/state/bucket';
import { bucketPath, databasePath, stateRoot } from '../../../src/state/paths';
import type { DocumentName } from '../../../src/state/store';
import type { StateContext } from '../../../src/state/sync';
import type { Runner } from '../../../src/types';
import { World, steps } from '../../support/gherkin';
import {
  fakeLitestream,
  type FakeLitestream,
} from '../support/litestream-fake';

export const REPOSITORY = resolve(import.meta.dir, '../../..');
/** "The example fleet": examples/fleet.json without the bucket it names, the
 * configuration every scenario runs with (features/support/setup.ts).
 */
export const EXAMPLE = process.env['DEVFLEET_CONFIG']!;
/** "The example fleet.json": the tracked file as it is. It names a bucket. */
export const EXAMPLE_FILE = join(REPOSITORY, 'examples/fleet.json');

/** One manager of the scenario's fleet: a home directory of its own, what the
 * commands started on it are passed, and where it replicates to.
 */
export class Manager {
  env: NodeJS.ProcessEnv = {};
  bucket: Bucket | null = null;
  /** Answers the prompts of a command; null where there is no terminal. */
  ask: ((question: string) => Promise<string>) | null = null;
  /** The machine the manager lease names; none unless a scenario says so. */
  holder: string | null = null;
  /** Take the lease from another manager. */
  takeOver = false;
  /** The manager's clock, when a scenario moves it. */
  clock: Date | undefined;
  constructor(
    readonly home: string,
    public run: Runner
  ) {}
  /** Its fleet state directory. */
  get root(): string {
    return stateRoot(this.env, this.home);
  }
  get database(): string {
    return databasePath(this.root);
  }
  get bucketFile(): string {
    return bucketPath(this.env, this.home);
  }
  get context(): StateContext {
    const clock = this.clock;
    return {
      root: this.root,
      bucket: this.bucket,
      run: this.run,
      holder: this.holder,
      takeOver: this.takeOver,
      ...(clock ? { now: () => clock } : {}),
    };
  }
  /** For the functions that are given an environment and no home directory:
   * without DEVFLEET_STATE they would use the fleet state of whoever runs
   * the scenario.
   */
  get stateEnv(): NodeJS.ProcessEnv {
    return { ...this.env, DEVFLEET_STATE: this.root };
  }
}

export class StateWorld extends World {
  private directory: string | undefined;
  private stand: FakeLitestream | undefined;
  private readonly known = new Map<string, Manager>();
  private result: unknown;
  private refusal: Error | undefined;
  private refusalRead = false;
  /** A time a scenario noted: `$NOTED` in a command. */
  noted: string | undefined;
  /** A bucket made on the S3 service DEVFLEET_TEST_S3 names. */
  s3: { origin: string; bucket: string; made: boolean } | undefined;

  constructor() {
    super();
    // Registered first, so it runs after everything else is undone.
    this.defer(() => {
      if (this.refusal && !this.refusalRead) throw this.refusal;
    });
  }

  /** A directory of the scenario's own, removed afterwards. Resolved, because
   * the run lock refuses a path through a symbolic link, as the temporary
   * directory is on macOS.
   */
  get root(): string {
    if (this.directory) return this.directory;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-state-')));
    this.defer(() => rmSync(directory, { recursive: true, force: true }));
    return (this.directory = directory);
  }

  /** The directory that stands in for the bucket: `$BUCKET`. */
  get remote(): string {
    return join(this.root, 'remote');
  }

  /** Stands in for Litestream and keeps the bucket in `remote`. */
  get litestream(): FakeLitestream {
    return (this.stand ??= fakeLitestream(this.remote));
  }

  /** "manager "a"", or "the manager" when a scenario has only one. */
  manager(name?: string | null): Manager {
    const key = name ?? '';
    const known = this.known.get(key);
    if (known) return known;
    const home = join(this.root, name ?? 'manager');
    mkdirSync(home, { recursive: true });
    const manager = new Manager(home, this.litestream.run);
    this.known.set(key, manager);
    return manager;
  }

  /** A path or a command as a feature writes it: `~` is the manager's home,
   * `$BUCKET` the stand-in bucket, `$EXAMPLE` the example fleet,
   * examples/fleet.json the tracked file, `$S3` and `$S3_BUCKET` the S3
   * service and the bucket made on it.
   */
  expand(text: string, manager: Manager): string {
    if (text === 'examples/fleet.json') return EXAMPLE_FILE;
    return text
      .replace(/^~(?=\/|$)/, manager.home)
      .replaceAll('$BUCKET', () => this.remote)
      .replaceAll('$EXAMPLE', () => EXAMPLE)
      .replaceAll('$NOTED', (name) => this.noted ?? name)
      .replaceAll('$S3_BUCKET', (name) => this.s3?.bucket ?? name)
      .replaceAll('$S3', (name) => this.s3?.origin ?? name);
  }

  /** Runs what a `When` step describes and keeps its result, or how it was
   * refused. A refusal no `Then` step asked about fails the scenario.
   */
  async attempt(action: () => unknown): Promise<void> {
    this.result = undefined;
    this.refusal = undefined;
    this.refusalRead = false;
    try {
      this.result = await action();
    } catch (error) {
      this.refusal = error instanceof Error ? error : new Error(String(error));
    }
  }

  /** What the `When` step returned. */
  outcome<T>(): T {
    if (this.refusal) throw this.refusal;
    return this.result as T;
  }

  /** How the `When` step was refused. */
  refused(): Error {
    this.refusalRead = true;
    if (!this.refusal) throw new Error('It was not refused.');
    return this.refusal;
  }

  /** Points this process at a manager's fleet state and bucket.json, for the
   * code that reads them from the process environment.
   */
  bind(manager: Manager): void {
    this.setEnv('DEVFLEET_STATE', join(manager.home, 'state'));
    this.setEnv('DEVFLEET_BUCKET', join(manager.home, 'bucket.json'));
    manager.env['DEVFLEET_STATE'] = process.env['DEVFLEET_STATE'];
    manager.env['DEVFLEET_BUCKET'] = process.env['DEVFLEET_BUCKET'];
  }

  /** Sets a variable of this process until the scenario ends. */
  setEnv(name: string, value: string): void {
    const before = process.env[name];
    process.env[name] = value;
    this.defer(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
      reloadFleet();
    });
  }
}

export const state = steps<StateWorld>();

/** `the manager`, or `manager "a"`: captures the name, or nothing. */
export const WHO = String.raw`(?:the manager|manager "([^"]+)")`;
/** `the fleet state`, or that of a named manager: captures the name. */
export const STATE = String.raw`the fleet state(?: of the manager| of manager "([^"]+)")?`;
/** A text in double or in single quotes: captures one of the two. */
export const TEXT = String.raw`(?:"([^"]*)"|'([^']*)')`;
/** One of the three documents, as a feature names it. */
export const DOCUMENT = '(configuration|roster|enrollment)';

/** A step's expression from its parts, anchored at both ends. */
export const phrase = (...parts: string[]): RegExp =>
  new RegExp(`^${parts.join('')}$`);

export const documentName = (word: string): DocumentName =>
  word === 'configuration' ? 'definition' : (word as DocumentName);

export const json = (text: string): unknown => JSON.parse(text) as unknown;

/** How a step was worded: what happens (`When`), what happened before
 * (`Given`, where a failure fails the scenario) or what was tried and may
 * have been refused.
 */
export async function act(
  world: StateWorld,
  verb: string,
  action: () => unknown
): Promise<void> {
  if (verb.startsWith('tried')) {
    try {
      await action();
    } catch {
      // Refused, as the scenario expects.
    }
    return;
  }
  if (PRESENT.has(verb)) await world.attempt(action);
  else await action();
}
const PRESENT = new Set([
  'is',
  'are',
  'changes',
  'compares',
  'refreshes',
  'pushes',
  'restores',
  'makes',
  'runs',
  'installs',
  'converges',
]);

/** A piece of the world only one file of steps uses. */
export function scratch<T>(create: () => T): (world: StateWorld) => T {
  const kept = new WeakMap<StateWorld, T>();
  return (world) => {
    let value = kept.get(world);
    if (value === undefined) {
      value = create();
      kept.set(world, value);
    }
    return value;
  };
}
