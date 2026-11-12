import { CAPABILITIES, record } from './config';
import { FleetUsageError } from './errors';
import type { Capability } from './types';
import { TOOL_PROFILES, type ToolProfile } from '../bootstrap/worker-tools';

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
function validPolicy(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).every((key) =>
      [
        'requiredCapabilities',
        'githubLogin',
        'vaultUser',
        'toolchain',
        'agentProfile',
        'unattendedSudo',
        'persistentT3',
        'neverSleep',
        'toolProfiles',
        'tools',
      ].includes(key)
    ) &&
    validTools(value) &&
    validCapabilities(value['requiredCapabilities']) &&
    typeof value['githubLogin'] === 'string' &&
    /^[a-zA-Z0-9-]{1,39}$/.test(value['githubLogin']) &&
    typeof value['vaultUser'] === 'string' &&
    /^[a-zA-Z0-9_.-]{1,64}$/.test(value['vaultUser']) &&
    value['toolchain'] === 'mise.lock' &&
    value['agentProfile'] === 'proxy' &&
    ['unattendedSudo', 'persistentT3', 'neverSleep'].every(
      (key) => value[key] === true
    )
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
/** The optional tool profiles and single tools every worker adds. */
function validTools(value: Record<string, unknown>): boolean {
  return (
    (value['toolProfiles'] === undefined ||
      toolProfiles(value['toolProfiles']) !== null) &&
    (value['tools'] === undefined || toolNames(value['tools']))
  );
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
  if (!record(value) || !validPolicy(value))
    throw new FleetUsageError(
      'Invalid mandatory worker policy. Workers require the locked toolchain, common services, unattended sudo, persistent T3 and no sleep.'
    );
  return value as unknown as WorkerPolicy;
}
