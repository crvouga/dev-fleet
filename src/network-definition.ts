import {
  sshTarget,
  type FleetDefinition,
  type MachineDefinition,
} from './definition';
import { record } from './config';
import { FleetUsageError } from './errors';

export interface NetworkHost {
  alias: string;
  tailscaleName: string;
  sshPort: number;
  user: string;
  identityFile: string;
  os: 'linux';
  t3Port: number;
}
export function networkProjection(
  definition: FleetDefinition,
  identities: Record<string, string>
): NetworkHost[] {
  return definition.workers.flatMap((node) =>
    node.network
      ? [
          {
            alias: sshTarget(node),
            tailscaleName: node.network.tailscaleName,
            user: node.network.user,
            sshPort: node.network.sshPort,
            t3Port: node.network.t3Port,
            os: node.os,
            identityFile: identities[node.id] ?? '',
          },
        ]
      : []
  );
}
function compatible(
  node: MachineDefinition | undefined,
  host: Record<string, unknown>
): node is MachineDefinition {
  return Boolean(
    node?.network &&
    Object.entries(node.network)
      .filter(([key]) => key !== 'hostKey')
      .every(([key, value]) => host[key] === value) &&
    node.os === host['os']
  );
}
/** Immutable migration input supplies old manager paths only, never desired hosts. */
export function legacyIdentities(
  definition: FleetDefinition,
  raw: unknown
): Record<string, string> {
  if (!record(raw) || !Array.isArray(raw['hosts']))
    throw new FleetUsageError('Invalid legacy Workstation inventory.');
  const result: Record<string, string> = {};
  for (const host of raw['hosts']) {
    if (!record(host))
      throw new FleetUsageError('Invalid legacy network host.');
    const node = definition.workers.find((node) => node.ssh === host['alias']);
    // A retired host has no manager identity to migrate into this fleet.
    if (!node) continue;
    if (!compatible(node, host))
      throw new FleetUsageError(
        'Legacy Workstation and canonical Fleet definitions conflict. Review IDs, aliases and network settings before migration.'
      );
    const identity = host['identityFile'];
    if (
      typeof identity !== 'string' ||
      !/^(~\/|\/)[^\x00-\x1f\x7f]+$/.test(identity)
    )
      throw new FleetUsageError('Legacy identity path is invalid.');
    if (result[node.id] !== undefined)
      throw new FleetUsageError('Duplicate legacy machine assignment.');
    result[node.id] = identity;
  }
  return result;
}
/** `legacy` is the consumer's earlier inventory, when it has one: it only
 * supplies identity paths the fleet configuration does not hold.
 */
export function loadNetworkDefinition(
  definition: FleetDefinition,
  legacy: unknown,
  overrides?: Record<string, string>
): NetworkHost[] {
  return networkProjection(
    definition,
    overrides ?? legacyIdentities(definition, legacy)
  );
}
