import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Saves the full JSON report of the latest run (0600, manager-private) so an
 * agent can debug without rerunning. Reports carry codes and remedies only,
 * never secret values. Returns null when it cannot be written.
 */
export async function saveReport(
  root: string,
  data: unknown
): Promise<string | null> {
  try {
    const directory = join(root, 'reports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'last-sync.json');
    const partial = `${path}.partial`;
    await writeFile(partial, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(partial, 0o600);
    await rename(partial, path);
    return path;
  } catch {
    return null;
  }
}
