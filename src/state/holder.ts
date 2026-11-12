import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The machine's own identifier, which survives a reinstall of dev-fleet
 * and differs between two Macs given the same host name.
 */
function machineId(platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'linux')
      return readFileSync('/etc/machine-id', 'utf8').trim() || null;
    if (platform === 'darwin') {
      const ioreg = spawnSync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 5_000 }
      );
      return (
        /"IOPlatformUUID" = "([^"]+)"/.exec(ioreg.stdout ?? '')?.[1] ?? null
      );
    }
  } catch {
    // An unidentified machine neither checks nor takes the lease.
  }
  return null;
}

const known = new Map<string, string | null>();

/** This machine, as the manager lease names it: a digest of its machine ID,
 * never the ID itself. `DEVFLEET_MANAGER_HOLDER` names it instead (a test, a
 * container without a machine ID). Null when it cannot be told apart.
 */
export function managerHolder(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const named = env['DEVFLEET_MANAGER_HOLDER'];
  if (named) return named;
  if (!known.has(platform)) {
    const id = machineId(platform);
    known.set(
      platform,
      id
        ? `machine-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
        : null
    );
  }
  return known.get(platform) ?? null;
}
