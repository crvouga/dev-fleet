import { AgentConfigurationError } from './errors';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, parse } from 'node:path';
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

export function fileState(
  current: string | null,
  desired: string,
  previous?: string
): string {
  if (current === desired) return 'unchanged';
  if (current === null) return 'create';
  return previous === digest(current) ? 'update' : 'conflict';
}
