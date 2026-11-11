import { readFile } from 'node:fs/promises';
import type { Capability, FleetConfig, FleetNode } from './types';
import { FleetUsageError } from './errors';

export const CAPABILITIES: Capability[] = [
  'github',
  'vault',
  't3',
  'vscode',
  'toolchain',
  'codex',
  'claude',
  'services',
  'workstation',
  'worker',
];
export const DEFAULT_CONFIG = '.fleet.local.json';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new FleetUsageError(
      'Unknown configuration field. Run fleet-nodes --schema.'
    );
  }
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function parseNode(value: unknown): FleetNode {
  if (!record(value)) throw new FleetUsageError('Each node must be an object.');
  fields(value, [
    'id',
    'ssh',
    'workspace',
    'runtime',
    'required',
    'tailscaleId',
    't3EnvironmentId',
    'bootstrapViaSsh',
  ]);
  if (
    value['t3EnvironmentId'] !== undefined &&
    (typeof value['t3EnvironmentId'] !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
        value['t3EnvironmentId']
      ))
  )
    throw new FleetUsageError('Invalid enrolled T3 environment identity.');
  const names = nodeNames(value);
  if (!absolutePath(value['workspace']))
    throw new FleetUsageError('workspace must be an absolute POSIX path.');
  if (value['runtime'] !== undefined && !absolutePath(value['runtime'])) {
    throw new FleetUsageError(
      'runtime must be an absolute POSIX path to Node or Bun.'
    );
  }
  return {
    ...names,
    ...enrollmentOptions(value),
    ...(typeof value['t3EnvironmentId'] === 'string'
      ? { t3EnvironmentId: value['t3EnvironmentId'] }
      : {}),
    workspace: value['workspace'],
    ...(typeof value['runtime'] === 'string'
      ? { runtime: value['runtime'] }
      : {}),
    required: requiredCapabilities(value['required']),
  };
}

function enrollmentOptions(
  value: Record<string, unknown>
): Pick<FleetNode, 'tailscaleId' | 'bootstrapViaSsh'> {
  if (
    value['bootstrapViaSsh'] !== undefined &&
    typeof value['bootstrapViaSsh'] !== 'boolean'
  )
    throw new FleetUsageError(
      'bootstrapViaSsh must explicitly authorize an existing trusted SSH bootstrap route.'
    );
  if (
    value['tailscaleId'] !== undefined &&
    (typeof value['tailscaleId'] !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(value['tailscaleId']))
  )
    throw new FleetUsageError(
      'tailscaleId must be the explicitly enrolled stable Tailscale device ID.'
    );
  return {
    ...(value['bootstrapViaSsh'] === true ? { bootstrapViaSsh: true } : {}),
    ...(typeof value['tailscaleId'] === 'string'
      ? { tailscaleId: value['tailscaleId'] }
      : {}),
  };
}

function nodeNames(
  value: Record<string, unknown>
): Pick<FleetNode, 'id' | 'ssh'> {
  if (
    typeof value['id'] !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(value['id'])
  ) {
    throw new FleetUsageError(
      'Node IDs must be lowercase names (1–63 characters).'
    );
  }
  if (
    typeof value['ssh'] !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value['ssh'])
  ) {
    throw new FleetUsageError(
      'ssh must be a plain SSH alias or hostname, not options or user@host.'
    );
  }
  return { id: value['id'], ssh: value['ssh'] };
}

function requiredCapabilities(value: unknown): Capability[] {
  const required =
    value === undefined ? ['github', 'vault', 't3', 'toolchain'] : value;
  if (
    !Array.isArray(required) ||
    required.some((item) => !CAPABILITIES.includes(item as Capability))
  ) {
    throw new FleetUsageError(
      'required must contain only capability names from fleet-nodes --schema.'
    );
  }
  if (new Set(required).size !== required.length)
    throw new FleetUsageError('required capabilities must be unique.');
  return required as Capability[];
}

export function parseConfig(value: unknown): FleetConfig {
  if (!record(value))
    throw new FleetUsageError('Fleet configuration must be an object.');
  fields(value, ['$schema', 'version', 'nodes']);
  if (value['$schema'] !== undefined && typeof value['$schema'] !== 'string')
    throw new FleetUsageError('$schema must be a string.');
  if (value['version'] !== 1 || !Array.isArray(value['nodes'])) {
    throw new FleetUsageError('Expected version 1 and a nodes array.');
  }
  if (value['nodes'].length < 1 || value['nodes'].length > 64) {
    throw new FleetUsageError('Configure between 1 and 64 developer nodes.');
  }
  const nodes = value['nodes'].map(parseNode);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new FleetUsageError('Node IDs must be unique.');
  }
  return { version: 1, nodes };
}

export async function loadConfig(path: string): Promise<FleetConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new FleetUsageError(
      'Cannot read fleet config. Run devfleet fleet-node-add or use --config PATH.'
    );
  }
  return parseConfig(value);
}

export function selectNodes(config: FleetConfig, ids: string[]): FleetNode[] {
  if (ids.some((id) => !config.nodes.some((node) => node.id === id))) {
    throw new FleetUsageError(
      'Unknown node selection. Run fleet-nodes --json.'
    );
  }
  return ids.length === 0
    ? config.nodes
    : config.nodes.filter((node) => ids.includes(node.id));
}
