import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where this code's own files live: the published package, or a checkout. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface PackageInfo {
  name: string;
  version: string;
  /** The commit this package was published from; null in a checkout. */
  revision: string | null;
  /** Where a defect or a feature request is raised (`bugs` in the manifest). */
  issues: string | null;
}

function issueTracker(bugs: unknown): string | null {
  const url =
    typeof bugs === 'object' && bugs !== null
      ? (bugs as { url?: unknown }).url
      : bugs;
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) ? url : null;
}

/** What the running package says about itself. The release workflow stamps
 * the version and the commit (`gitHead`) into the package it publishes, so an
 * installed dev-fleet knows which revision every machine has to run. A
 * checkout carries neither: its revision is its own HEAD. The issue tracker
 * comes from the manifest too, so a fork sends its users to its own.
 */
export function packageInfo(root = PACKAGE_ROOT): PackageInfo {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  ) as { name?: unknown; version?: unknown; gitHead?: unknown; bugs?: unknown };
  const { gitHead } = manifest;
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    revision:
      typeof gitHead === 'string' && /^[a-f0-9]{40}$/.test(gitHead)
        ? gitHead
        : null,
    issues: issueTracker(manifest.bugs),
  };
}
