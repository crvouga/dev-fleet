import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDefinition, type FleetDefinition } from './definition';
import { FleetUsageError } from './errors';
import { pinnedPath } from './agents/toolchain';
import type { Runner } from './types';
import {
  secretsProvider,
  type SecretCommand,
  type SecretsProvider,
} from './secrets';

/** Where every machine keeps the fleet configuration. fleet-sync installs the
 * approved copy here, so launchers and scheduled jobs find it without any
 * environment. `DEVFLEET_CONFIG` names another file (the manager's checkout of
 * its configuration repository, or a test fixture).
 */
export function configPath(env = process.env, home = homedir()): string {
  return env['DEVFLEET_CONFIG'] || join(home, '.config/dev-fleet/fleet.json');
}

/** Installs the configuration this process runs with as the machine's copy,
 * so launchers and scheduled jobs (which get no environment) use the same one.
 * Returns whether the file changed.
 */
export function installConfig(home = homedir()): boolean {
  const target = join(home, '.config/dev-fleet/fleet.json');
  const content = JSON.stringify(fleet, null, 2) + '\n';
  if (existsSync(target) && readFileSync(target, 'utf8') === content)
    return false;
  mkdirSync(join(home, '.config/dev-fleet'), { recursive: true, mode: 0o700 });
  writeFileSync(`${target}.new`, content, { mode: 0o600 });
  renameSync(`${target}.new`, target);
  return true;
}

function load(): FleetDefinition {
  const path = configPath();
  if (!existsSync(path))
    throw new FleetUsageError(
      `No fleet configuration at ${path}. Copy examples/fleet.json, edit it for your machines, and set DEVFLEET_CONFIG or place it there.`
    );
  return parseDefinition(JSON.parse(readFileSync(path, 'utf8')));
}

/** This fleet's own configuration: its machines, endpoints, accounts and source
 * repository. Fleet code never names any of them; it reads them here, and this
 * is the only module that loads the file.
 */
export const fleet = load();

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
