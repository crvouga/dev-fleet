import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { FleetUsageError } from '../errors';

export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export async function safePath(path: string): Promise<void> {
  for (
    let current = resolve(path);
    current !== parse(current).root;
    current = dirname(current)
  ) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new FleetUsageError('Managed T3 paths cannot be symlinks.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function read(path: string): Promise<string | null> {
  await safePath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024)
      throw new FleetUsageError(
        'T3 configuration must be a regular file smaller than 4 MiB.'
      );
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function write(path: string, contents: string): Promise<void> {
  await safePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function object(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* No contents or parser details in errors. */
  }
  throw new FleetUsageError(
    'Invalid T3 JSON object. Repair the file before reconciliation.'
  );
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
