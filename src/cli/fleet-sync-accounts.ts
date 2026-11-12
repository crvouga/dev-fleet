import { enrolledRoster } from '../definition';
import { selectNodes } from '../config';
import { fleet as definition } from '../fleet-config';
import { bundleProbe } from '../transport';
import { machineProviders } from '../t3/providers';
import { accountContext, nodeAccountChecks } from '../accounts/context';
import { propagateAccounts } from '../accounts/propagate';
import { loadRoster } from './roster';
import { ownerCheckout } from './source-operations';
import type { Check, FleetNode, Runner } from '../types';
import type { FleetSyncOptions } from './fleet-sync';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';

/** `fleet-sync --only accounts` on the manager. */
export async function syncAccounts(
  options: FleetSyncOptions,
  settings: Settings,
  { revision, run }: { revision: string; run: Runner }
): Promise<CommandOutcome> {
  let nodes: FleetNode[] = [];
  try {
    nodes = selectNodes(
      enrolledRoster(definition, await loadRoster(settings.config)),
      options.node ?? []
    );
  } catch {
    // No enrolled worker yet: the manager alone.
  }
  return propagateAccounts({
    nodes,
    revision,
    source: await bundleProbe(),
    manager: () => managerAccounts(settings.workspace),
    run,
  });
}

/** The manager's own account instances, from the checkout it runs. */
export async function managerAccounts(workspace: string): Promise<Check[]> {
  const checkout = ownerCheckout(workspace);
  if (!checkout)
    return [
      {
        id: 't3:providers',
        status: 'fail',
        summary: 'No revision is applied on the manager yet.',
        remedy: {
          action: 'Run a full fleet-sync first.',
          command: 'devfleet fleet-sync',
        },
      },
    ];
  return [
    await machineProviders(definition.manager.id, checkout, true),
    ...(await nodeAccountChecks(await accountContext())),
  ];
}
