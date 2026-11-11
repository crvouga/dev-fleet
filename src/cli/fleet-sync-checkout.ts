import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSource } from '../machine/source';
import { PACKAGE_ROOT, packageInfo } from '../package-info';
import { trackedScript } from '../remote-bootstrap';
import type { Runner } from '../types';
import type { CommandOutcome } from './contracts';
import type { FleetSyncOptions } from './fleet-sync';
import { forwardedFlags, type ForwardSpawn } from './fleet-sync-forward';

/** Exported by `fleet-manager-run.sh`: this process already runs from the
 * fleet-owned checkout of that revision.
 */
export const RUN_CHECKOUT_ENV = 'PERSONAL_FLEET_RUN_CHECKOUT';

const RUN_SCRIPT = 'bootstrap/fleet-manager-run.sh';

export const inRunCheckout = (revision: string): boolean =>
  process.env[RUN_CHECKOUT_ENV] === revision;

export interface RunSource {
  revision: string;
  /** Where this process runs from: the installed package, or a checkout. */
  workspace: string;
  /** The manager's own caches; the fleet-owned source repository lives here. */
  root: string;
}

/** The revision's run script: tracked in a checkout, or shipped in the
 * package when the package is that revision.
 */
export async function managerRunScript(
  workspace: string,
  revision: string,
  run: Runner,
  shipped = { revision: packageInfo().revision, root: PACKAGE_ROOT }
): Promise<string | null> {
  const tracked = await trackedScript(workspace, revision, RUN_SCRIPT, run);
  if (tracked || shipped.revision !== revision) return tracked;
  try {
    const script = readFileSync(join(shipped.root, RUN_SCRIPT), 'utf8');
    return script.startsWith('#!/bin/sh\n') ? script : null;
  } catch {
    return null;
  }
}

/** The manager converges from a clean, fleet-owned checkout of the exact
 * revision, like every worker, never from where fleet-sync was started: that
 * is an installed package a package manager may remove, or a working tree
 * with uncommitted edits. The checkout is made from a repository this machine
 * owns too: the fleet's source repository fetched into the manager's cache
 * (a checkout that already holds the revision supplies it without a fetch).
 * Null when the revision cannot be taken from either.
 */
export async function runFromCheckout(
  options: FleetSyncOptions,
  source: RunSource,
  run: Runner,
  spawnLocal: ForwardSpawn = spawnInherited
): Promise<CommandOutcome | null> {
  const { revision } = source;
  const repository = await prepareSource(
    source.root,
    revision,
    run,
    source.workspace
  );
  const script =
    repository && (await trackedScript(repository, revision, RUN_SCRIPT, run));
  if (!repository || !script) return null;
  // The run script makes its checkout from this repository.
  process.env['DEVFLEET_REPO'] = repository;
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

/** `here` when this process is already the run checkout (or a test, which
 * never leaves its own process: the same rule as the worker hand-off).
 * `unavailable` when the revision could not be checked out: nothing may
 * converge from the place fleet-sync happened to be started in.
 */
export async function rehome(
  options: FleetSyncOptions,
  source: RunSource,
  run: Runner
): Promise<CommandOutcome | 'here' | 'unavailable'> {
  if (inRunCheckout(source.revision) || process.env['NODE_ENV'] === 'test')
    return 'here';
  return (await runFromCheckout(options, source, run)) ?? 'unavailable';
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
