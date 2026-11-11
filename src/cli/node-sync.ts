import { join } from 'node:path';
import { configureWorkspace } from '../configure';
import { runCommand } from '../runner';
import { FleetUsageError } from '../errors';
import { packageInfo } from '../package-info';
import type { Runner } from '../types';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';
import { syncT3 } from './node-t3';
import { nodeId, type T3Options } from '../t3/desired';
import { recordDeployment } from './node-deployment';

export interface NodeSyncOptions extends T3Options {
  revision?: string;
}

/** One local convergence: locked tools, public launcher, profiles, then T3. */
export async function syncNode(
  options: NodeSyncOptions,
  settings: Settings,
  run: Runner = runCommand
): Promise<CommandOutcome> {
  if (process.platform === 'win32' && !options.dryRun)
    throw new FleetUsageError(
      'Codex proxy node sync requires macOS/Linux/WSL. Use dev-fleet commands for native Windows configuration.'
    );
  const node = nodeId(options.id);
  // An installed package is not a checkout, and the Git repository around it
  // is the operator's own project: its HEAD is not a dev-fleet revision.
  if (packageInfo().revision)
    throw new FleetUsageError(
      'fleet-node-sync works on a checkout of dev-fleet. Run fleet-sync instead: it converges this machine from a checkout it owns.'
    );
  const head = await run(['git', 'rev-parse', '--verify', 'HEAD'], {
    cwd: settings.workspace,
  });
  const revision = options.revision ?? head.stdout.trim();
  if (!head.ok || !/^[a-f0-9]{40}$/.test(revision))
    throw new FleetUsageError(
      'An existing personal checkout is required; set --workspace PATH.'
    );
  const request = { node, revision, tool: 'codex', profile: 'proxy' };
  if (options.dryRun)
    return {
      exitCode: 0,
      data: {
        version: 1,
        command: 'fleet-node-sync',
        ok: true,
        applied: false,
        ...request,
        steps: [
          'Reconcile locked tools',
          'Install personal and retire owned ws launcher',
          'Upsert Codex proxy profile',
          'Reconcile declared T3 instances and remove stale owned entries',
        ],
      },
    };
  const checks = await configureWorkspace(settings.workspace, request, run);
  if (checks.some((check) => check.status !== 'pass'))
    return {
      exitCode: 1,
      data: { version: 1, command: 'fleet-node-sync', ok: false, checks },
    };
  return finishSync(options, settings, { request, checks }, run);
}

async function finishSync(
  options: NodeSyncOptions,
  settings: Settings,
  input: {
    request: { node: string; revision: string; tool: string; profile: string };
    checks: Awaited<ReturnType<typeof configureWorkspace>>;
  },
  run: Runner
): Promise<CommandOutcome> {
  const { request, checks } = input;
  const { node, revision } = request;
  const workspace = join(
    settings.workspace,
    'node_modules/.fleet-revisions',
    revision
  );
  const installed = await run(['sh', 'bootstrap/install-launcher.sh'], {
    cwd: workspace,
    timeoutMs: 30_000,
  });
  if (!installed.ok)
    return {
      exitCode: 1,
      data: {
        version: 1,
        ok: false,
        checks,
        error:
          'Launcher installation failed; profile changes may already have applied.',
      },
    };
  const t3 = await syncT3({ ...options, id: node }, { ...settings, workspace });
  if (t3.exitCode !== 0) return t3;
  await recordDeployment(settings.workspace, node, revision);
  return {
    exitCode: 0,
    data: {
      version: 1,
      command: 'fleet-node-sync',
      ok: true,
      applied: true,
      ...request,
      checks,
      t3: t3.data,
      readiness: {
        authentication: 'unverified',
        inference: 'unverified',
        pairing: 'unverified',
      },
      next: 'Use devfleet t3-status for configuration drift and devfleet fleet-status for machine health.',
    },
  };
}
