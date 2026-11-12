import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  installedDefinition,
  parseDefinition,
  type FleetDefinition,
} from './definition';
import { FleetUsageError } from './errors';
import { pinnedPath } from './agents/toolchain';
import type { Runner } from './types';
import {
  secretsProvider,
  type SecretCommand,
  type SecretsProvider,
} from './secrets';
import { isOperator, stateDefinition } from './state/operator';
import type { BucketLocation } from './state/bucket';
import { definitionPath, stateRoot } from './state/paths';
import { expandRecords } from './worker-records';

/** Where every machine keeps the fleet configuration fleet-sync approved.
 * Launchers and scheduled jobs get no environment and read it from here.
 */
const installedPath = (home: string): string =>
  join(home, '.config/dev-fleet/fleet.json');

/** Where this process reads the fleet configuration from, in this order:
 * - `file`: the file `DEVFLEET_CONFIG` names. The devfleet CLI sets it to the
 *   `fleet.json` of the project it is run from (src/cli/project.ts);
 * - `state`: the `definition` document in the manager's fleet state, the
 *   configuration fleet-sync last applied, which only the devfleet CLI
 *   reads. `path` is its copy as a file;
 * - `installed`: the copy fleet-sync installed on this machine.
 */
export interface DefinitionSource {
  kind: 'file' | 'state' | 'installed';
  path: string;
}

export function definitionSource(
  env = process.env,
  home = homedir()
): DefinitionSource {
  const root = stateRoot(env, home);
  const copy = definitionPath(root);
  const named = env['DEVFLEET_CONFIG'];
  // A devfleet command names the state's copy for the commands it starts.
  const inherited = named === copy && isOperator();
  if (named && !inherited) return { kind: 'file', path: named };
  if (stateDefinition(root) !== null) return { kind: 'state', path: copy };
  return { kind: 'installed', path: installedPath(home) };
}

function writePrivate(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.new`, content, { mode: 0o600 });
  renameSync(`${path}.new`, path);
  return true;
}

/** The file that holds the configuration this process runs with, for the
 * subprocesses that take a path. Every command this process starts reads the
 * same one.
 */
export function configPath(env = process.env, home = homedir()): string {
  const source = definitionSource(env, home);
  if (source.kind !== 'state') return source.path;
  const body = stateDefinition(stateRoot(env, home));
  if (body !== null) writePrivate(source.path, body);
  env['DEVFLEET_CONFIG'] = source.path;
  return source.path;
}

/** Installs the configuration this process runs with as the machine's copy,
 * so launchers and scheduled jobs (which get no environment) use the same one.
 * Returns whether the file changed.
 */
export function installConfig(home = homedir()): boolean {
  return writePrivate(installedPath(home), installedDefinition(fleet));
}

function read(path: string): FleetDefinition {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new FleetUsageError(
      `The fleet configuration at ${path} is not readable JSON.`
    );
  }
  // A project's fleet.json may name generated worker records beside it.
  return parseDefinition(expandRecords(value, dirname(path)));
}

function load(): FleetDefinition {
  const path = configPath();
  if (!existsSync(path))
    throw new FleetUsageError(
      `No fleet configuration. Run devfleet from the project that holds your fleet.json (devfleet fleet-state --example prints one to start from), or name the file with DEVFLEET_CONFIG. A manager whose bucket already holds one restores it with devfleet fleet-state --init. Looked at ${path}.`
    );
  return read(path);
}

/** Where the configuration says the fleet state is kept, read from the file
 * each time: null when it names no bucket, or when this machine has no
 * configuration yet.
 */
export function declaredState(
  env = process.env,
  home = homedir()
): BucketLocation | null {
  const path = configPath(env, home);
  return existsSync(path) ? (read(path).state ?? null) : null;
}

let loaded: FleetDefinition | undefined;
const current = (): FleetDefinition => (loaded ??= load());

/** Forgets the configuration read so far; the next use reads it again. For
 * a command that has just replaced the fleet state under itself.
 */
export function reloadFleet(): void {
  loaded = undefined;
}

/** This fleet's own configuration: its machines, endpoints, accounts and source
 * repository. Fleet code never names any of them; it reads them here, and this
 * is the only module that loads the file. It is read on first use, so a
 * command that needs no configuration runs on a machine that has none yet.
 */
export const fleet: FleetDefinition = new Proxy({} as FleetDefinition, {
  get: (_, key) => Reflect.get(current(), key),
  has: (_, key) => Reflect.has(current(), key),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_, key) =>
    Reflect.getOwnPropertyDescriptor(current(), key),
});

/** Reads one of this fleet's secrets for this node. Tools run from the pinned
 * toolchain, whatever PATH the caller (T3, launchd, systemd) started with.
 */
export const secret: SecretsProvider = (name) =>
  secretsProvider(fleet.secrets, { run: pinned })(name);

/** The same, through an injected runner (fleet-sync phases and their tests). */
export const secretVia = (run: Runner): SecretsProvider =>
  secretsProvider(fleet.secrets, {
    run: async (argv) => {
      const result = await run(argv, { timeoutMs: 20_000 });
      return result.ok ? result.stdout : null;
    },
  });

const pinned: SecretCommand = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      env: { ...process.env, PATH: pinnedPath() },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 65_536) output += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output : null));
  });
