import type { FleetDefinition } from './definition';

/** Fleet topology: one singleton manager (the human's machine) and stateless
 * Linux workers. Every singleton service runs on the manager; workers only
 * consume them and can be turned off, replaced or re-imaged at will. */
export type Role = 'manager' | 'worker';

export function roleOf(definition: FleetDefinition, id: string): Role | null {
  if (definition.manager.id === id) return 'manager';
  return definition.workers.some((entry) => entry.id === id) ? 'worker' : null;
}

/** Private Beszel hub URL on the manager; agents never use the public name. */
export function hubUrl(definition: FleetDefinition): string {
  return `https://${definition.manager.network.tailscaleName}:${definition.services.monitoring.hubPort}`;
}

/** Normalizes a macOS LocalHostName / hostname to a fleet ID for identity checks. */
export function hostId(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9-]/g, '-');
}
