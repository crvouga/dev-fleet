import { CAPABILITIES, record } from './config';
import { FleetUsageError } from './errors';
import type { Capability } from './types';
import { TOOL_PROFILES, type ToolProfile } from '../bootstrap/worker-tools';
import { featuresFault } from '../bootstrap/worker-features';
import type { FeaturesDefinition } from './definition';

export interface WorkerPolicy {
  requiredCapabilities: Capability[];
  githubLogin: string;
  /** Vault userpass login each node uses for its own periodic token. */
  vaultUser: string;
  toolchain: 'mise.lock';
  agentProfile: 'proxy';
  unattendedSudo: true;
  persistentT3: true;
  neverSleep: true;
  /** Tool profiles every worker installs on top of the base tools. */
  toolProfiles?: ToolProfile[];
  /** Single tools pinned in dev-fleet's mise.toml every worker installs. */
  tools?: string[];
  /** Features every worker has unless its own `features` say otherwise. */
  features?: FeaturesDefinition;
}
const REQUIRED = [
  'github',
  'vault',
  't3',
  'toolchain',
  'workstation',
  'worker',
];
function validCapabilities(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => CAPABILITIES.includes(item)) &&
    REQUIRED.every((item) => value.includes(item))
  );
}
const FIELDS: Record<string, (value: unknown) => boolean> = {
  requiredCapabilities: validCapabilities,
  githubLogin: (value) =>
    typeof value === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(value),
  vaultUser: (value) =>
    typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value),
  toolchain: (value) => value === 'mise.lock',
  agentProfile: (value) => value === 'proxy',
  unattendedSudo: (value) => value === true,
  persistentT3: (value) => value === true,
  neverSleep: (value) => value === true,
  toolProfiles: (value) => value === undefined || toolProfiles(value) !== null,
  tools: (value) => value === undefined || toolNames(value),
  features: (value) => value === undefined || featuresFault(value) === null,
};
/** The first field of a worker policy that breaks its rule, or null. */
export function policyFault(value: Record<string, unknown>): string | null {
  const unknown = Object.keys(value).find((key) => !(key in FIELDS));
  if (unknown !== undefined) return unknown;
  return (
    Object.entries(FIELDS).find(([key, valid]) => !valid(value[key]))?.[0] ??
    null
  );
}
/** A list of known tool profiles, each once; null when it is not one. */
export function toolProfiles(value: unknown): ToolProfile[] | null {
  return Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((item) => TOOL_PROFILES.includes(item as ToolProfile))
    ? (value as ToolProfile[])
    : null;
}
function toolNames(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(
      (item) => typeof item === 'string' && /^[a-z0-9@:/._-]{1,75}$/i.test(item)
    )
  );
}
export function parseWorkerPolicy(value: unknown): WorkerPolicy {
  if (!record(value) || policyFault(value) !== null)
    throw new FleetUsageError(
      'Invalid mandatory worker policy. Workers require the locked toolchain, common services, unattended sudo, persistent T3 and no sleep.'
    );
  return value as unknown as WorkerPolicy;
}
