import { spawn } from 'node:child_process';
import { trackedScript } from '../remote-bootstrap';
import type { Runner } from '../types';
import type { CommandOutcome } from './contracts';
import type { FleetSyncOptions } from './fleet-sync';
import { forwardedFlags, type ForwardSpawn } from './fleet-sync-forward';

/** Exported by `fleet-manager-run.sh`: this process already runs from the
 * fleet-owned checkout of that revision.
 */
export const RUN_CHECKOUT_ENV = 'PERSONAL_FLEET_RUN_CHECKOUT';

export const inRunCheckout = (revision: string): boolean =>
  process.env[RUN_CHECKOUT_ENV] === revision;

/** The manager converges from a clean, fleet-owned checkout of the exact
 * revision, like every worker, never from the checkout fleet-sync was started
 * in: that one is a working tree whose uncommitted edits, branch switches or
 * removal would otherwise decide whether a sync (and every provider it
 * installs) works. Null when the revision has no tracked run script.
 */
export async function runFromCheckout(
  options: FleetSyncOptions,
  source: { revision: string; workspace: string },
  run: Runner,
  spawnLocal: ForwardSpawn = spawnInherited
): Promise<CommandOutcome | null> {
  const { revision } = source;
  const script = await trackedScript(
    source.workspace,
    revision,
    'bootstrap/fleet-manager-run.sh',
    run
  );
  if (!script) return null;
  // The run script takes the revision from this clone.
  process.env['DEVFLEET_REPO'] ||= source.workspace;
  const result = await spawnLocal([
    'sh',
    '-c',
    script,
    'fleet-manager-run',
    revision,
    ...forwardedFlags(options, undefined),
  ]);
  const stdout = result.stdout.trim();
  if (options.json) {
    try {
      return { exitCode: result.exitCode, data: JSON.parse(stdout) as unknown };
    } catch {
      /* Fall through: the run checkout could not start; its reason is on stderr. */
    }
  }
  return {
    exitCode: result.exitCode,
    data: { version: 1, revision, exitCode: result.exitCode },
    text: stdout,
  };
}

/** Null when this process is already the run checkout (or a test, which
 * never leaves its own process: the same rule as the worker hand-off).
 */
export async function rehome(
  options: FleetSyncOptions,
  source: { revision: string; workspace: string },
  run: Runner
): Promise<CommandOutcome | null> {
  if (inRunCheckout(source.revision) || process.env['NODE_ENV'] === 'test')
    return null;
  return runFromCheckout(options, source, run);
}

/** Prompts and progress stay on the terminal; the report is returned. */
function spawnInherited(
  command: string[]
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const color = process.stdout.isTTY && !process.env['NO_COLOR'];
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, ...(color ? { FORCE_COLOR: '1' } : {}) },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ exitCode: 1, stdout: '' }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}
