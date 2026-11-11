import { CAPABILITIES, record } from './config';
import { FleetUsageError } from './errors';
import type { Capability } from './types';

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
      ].includes(key)
    ) &&
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
export function parseWorkerPolicy(value: unknown): WorkerPolicy {
  if (!record(value) || !validPolicy(value))
    throw new FleetUsageError(
      'Invalid mandatory worker policy. Workers require the locked toolchain, common services, unattended sudo, persistent T3 and no sleep.'
    );
  return value as unknown as WorkerPolicy;
}
