import { AgentConfigurationError } from './errors';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  copyFile,
  chmod,
} from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './registry';

export async function safeParents(path: string): Promise<void> {
  let current = path;
  while (current !== parse(current).root) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new AgentConfigurationError(
          'Symlink conflict; move the managed destination before applying.'
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = dirname(current);
  }
}

export async function readOwned(path: string): Promise<string | null> {
  await safeParents(path);
  try {
    if (!(await lstat(path)).isFile())
      throw new AgentConfigurationError(
        'Managed destination is not a regular file.'
      );
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(path: string, value: string): Promise<void> {
  await safeParents(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function backup(path: string, root: string): Promise<void> {
  const dir = join(root, 'backups');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, randomUUID());
  await copyFile(path, target);
  await chmod(target, 0o600);
}

export function fileState(
  current: string | null,
  desired: string,
  previous?: string
): string {
  if (current === desired) return 'unchanged';
  if (current === null) return 'create';
  return previous === digest(current) ? 'update' : 'conflict';
}
