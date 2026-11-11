import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** mise shims resolve every agent to the version pinned in the shared lock.
 * Putting them first keeps an unmanaged copy elsewhere on PATH (a vendor
 * installer in ~/.local/bin, an nvm global) from shadowing the pinned one.
 */
export function pinnedPath(env: NodeJS.ProcessEnv = process.env): string {
  const data =
    env['MISE_DATA_DIR'] ??
    join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'mise');
  const shims = join(data, 'shims');
  const rest = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => entry && entry !== shims);
  return [shims, ...rest].join(delimiter);
}

/** The real pinned executable behind a mise shim. Needed when a launch
 * changes HOME: a shim run under another HOME cannot find mise's trust state.
 */
export function pinnedBinary(
  tool: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = spawnSync('mise', ['which', tool], {
    encoding: 'utf8',
    env: { ...env, PATH: pinnedPath(env) },
    timeout: 15_000,
  });
  const path = result.status === 0 ? result.stdout.trim() : '';
  return path.startsWith('/') ? path : tool;
}
