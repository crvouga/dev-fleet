import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const INPUT_FILES = [
  'package.json',
  'bun.lock',
  'mise.toml',
  'mise.lock',
];
export const FINGERPRINT_FILES = [
  ...INPUT_FILES,
  'workspace-manifests',
  'mise-sidecars',
];

export async function fileHash(path: string): Promise<string | null> {
  try {
    return digest(await readFile(path));
  } catch {
    return null;
  }
}

/** A repository without a packages directory (dev-fleet itself) has an
 * empty set of workspace manifests, which is known, not missing.
 */
export async function manifestHash(root: string): Promise<string | null> {
  try {
    const entries = await readdir(join(root, 'packages'), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const hashes: string[] = [];
    for (const entry of entries
      .filter((item) => item.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      hashes.push(
        `${entry.name}:${await fileHash(join(root, 'packages', entry.name, 'package.json'))}`
      );
    }
    return digest(hashes.join('\n'));
  } catch {
    return null;
  }
}

export async function sidecarHash(root: string): Promise<string | null> {
  try {
    const files = await readdir(join(root, '.mise/locks'), {
      recursive: true,
      withFileTypes: true,
    });
    if (files.length > 4096 || files.some((entry) => entry.isSymbolicLink()))
      return null;
    const hashes: string[] = [];
    const paths = files
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const path of paths) {
      const hash = await fileHash(path);
      if (hash === null) return null;
      const relative = path
        .slice(join(root, '.mise/locks').length)
        .replaceAll('\\', '/');
      hashes.push(`${relative}:${hash}`);
    }
    return digest(hashes.join('\n'));
  } catch {
    return null;
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
