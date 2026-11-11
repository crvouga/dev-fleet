import { deployment } from '../node-deployment';
import type { CommandOutcome } from '../contracts';
import type { Settings } from '../settings';
import { FleetUsageError } from '../../errors';
import { desired, nodeId, paths, type T3Options } from '../../t3/desired';
import { importT3, reconcileT3 } from '../../t3/reconcile';

export async function t3Command(
  command: string,
  options: T3Options,
  settings: Settings
): Promise<CommandOutcome> {
  const deployed = options.definition
    ? null
    : await deployment(settings.workspace);
  const workspace = deployed?.workspace ?? settings.workspace;
  const target = paths(options, workspace);
  if (command === 't3-apply' && options.import !== undefined)
    return importCommand(target, options);
  const instances = await declared(command, target.definition, workspace, {
    ...options,
    id: nodeId(options.id ?? deployed?.node),
  });
  const apply = shouldApply(command, options);
  if (apply) requireSupportedPlatform(instances);
  const data = await reconcileT3(
    target,
    instances,
    reconcileOptions(apply, options)
  );
  return {
    exitCode: outcomeCode(command, data),
    data: { command, ...data },
  };
}

function declared(
  command: string,
  definition: string,
  workspace: string,
  options: T3Options & { id: string }
): Promise<Record<string, unknown>> {
  if (command === 't3-cleanup') return Promise.resolve({});
  // An explicit definition is the complete instance set.
  const roster =
    options.roster ?? (options.definition ? async () => [] : undefined);
  return desired(definition, workspace, options.id, roster);
}

async function importCommand(
  target: ReturnType<typeof paths>,
  options: T3Options
): Promise<CommandOutcome> {
  if (options.dryRun)
    throw new FleetUsageError(
      't3-apply --import adopts ownership and cannot be combined with --dry-run; inspect t3-apply --dry-run first.'
    );
  if (!options.import || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(options.import))
    throw new FleetUsageError(
      't3-apply --import expects an instance ID. Import authorizes management of that entire provider instance.'
    );
  return {
    exitCode: 0,
    data: { command: 't3-import', ...(await importT3(target, options.import)) },
  };
}

function reconcileOptions(apply: boolean, options: T3Options) {
  return {
    apply,
    ...(options.planHash ? { planHash: options.planHash } : {}),
  };
}

function shouldApply(command: string, options: T3Options): boolean {
  return ['t3-apply', 't3-cleanup'].includes(command) && !options.dryRun;
}
function outcomeCode(
  command: string,
  data: { ok: boolean; changed: boolean }
): number {
  return !data.ok || (command === 't3-status' && data.changed) ? 1 : 0;
}

function requireSupportedPlatform(instances: Record<string, unknown>): void {
  if (process.platform === 'win32' && Object.keys(instances).length)
    throw new FleetUsageError(
      'Managed Codex proxy execution requires macOS/Linux/WSL; native Windows settings were preserved.'
    );
}
