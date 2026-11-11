/** Nonsecret installer evidence; never contains commands, paths or raw errors. */
import { lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export type SetupPhase =
  | 'managed-config'
  | 'mise'
  | 'aws'
  | 't3'
  | 'global-config'
  | 'shell'
  | 'dependencies';
export function setupFailureCode(error: unknown): string | undefined {
  const known: Record<string, string> = {
    'Pinned T3 artifact unavailable.': 'T3_DOWNLOAD_UNAVAILABLE',
    'T3 artifact checksum mismatch.': 'T3_CHECKSUM_MISMATCH',
    'T3 cached artifact drift; preserve running service and review maintenance recovery.':
      'T3_CACHE_DRIFT',
    'T3 extraction failed.': 'T3_EXTRACTION_FAILED',
    'Managed T3 files differ from the pinned artifact; maintenance is required.':
      'T3_INSTALLATION_DRIFT',
    'Pinned T3 executable verification failed.': 'T3_EXECUTABLE_FAILED',
  };
  return error instanceof Error && Object.hasOwn(known, error.message)
    ? known[error.message]
    : undefined;
}
export function setupStatus(path: string | undefined) {
  if (path && !isAbsolute(path))
    throw new Error('Setup status path must be absolute.');
  return (
    phase: SetupPhase,
    status: 'running' | 'failed' | 'passed',
    code?: string
  ): void => {
    if (!path) return;
    try {
      if (!lstatSync(path).isFile())
        throw new Error('Unsafe setup status file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeFileSync(
      path,
      JSON.stringify({ version: 1, phase, status, ...(code ? { code } : {}) }) +
        '\n',
      {
        mode: 0o600,
      }
    );
  };
}
