import type { Fingerprint, Snapshot } from '../types';

declare const PERSONAL_FLEET_REFERENCE: Fingerprint | null | undefined;
/** Published health carries safe input hashes; it needs no manager checkout or Bun. */
export function fleetReference(): Snapshot | undefined {
  if (
    typeof PERSONAL_FLEET_REFERENCE === 'undefined' ||
    !PERSONAL_FLEET_REFERENCE?.head
  )
    return undefined;
  return {
    version: 1,
    platform: 'declared-worker-policy',
    fingerprint: PERSONAL_FLEET_REFERENCE,
    checks: [],
  };
}
