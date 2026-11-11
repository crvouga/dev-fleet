/** Publish one managed global mise config without clobbering unrelated configuration. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARKER = '# Managed by dev-fleet bootstrap/setup.ts\n';
const MANAGED = /^# Managed by \S+ \S*setup\.ts\n/;
export const workspaceRoot = join(import.meta.dirname, '..');

export function globalConfigDir(): string {
  if (process.env['MISE_GLOBAL_CONFIG_FILE']) {
    throw new Error(
      'Unset MISE_GLOBAL_CONFIG_FILE before applying the shared toolchain.'
    );
  }
  return (
    process.env['MISE_CONFIG_DIR'] ??
    join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'mise')
  );
}

export function assertManagedConfig(dir: string): void {
  const config = join(dir, 'config.toml');
  const lock = join(dir, 'mise.lock');
  // Any earlier owner name counts: the marker text identifies the file as
  // managed, never the repository or path it was published from.
  const managed =
    existsSync(config) && MANAGED.test(readFileSync(config, 'utf8'));
  if ((existsSync(config) && !managed) || (existsSync(lock) && !managed)) {
    throw new Error(
      `Existing mise configuration at ${dir}. Back up and move config.toml and mise.lock, then rerun. Nothing was overwritten.`
    );
  }
}

export function publishGlobalConfig(dir: string, root = workspaceRoot): void {
  assertManagedConfig(dir);
  mkdirSync(dir, { recursive: true });
  const config = readFileSync(join(root, 'mise.toml'), 'utf8');
  const path = join(dir, 'config.toml');
  if (!existsSync(path) || readFileSync(path, 'utf8') !== MARKER + config)
    writeFileSync(path, MARKER + config);
  cpSync(join(root, 'mise.lock'), join(dir, 'mise.lock'), {
    filter: changedFile,
  });
  const sidecars = join(root, '.mise/locks');
  if (existsSync(sidecars))
    cpSync(sidecars, join(dir, '.mise/locks'), {
      recursive: true,
      filter: changedFile,
    });
}

function changedFile(source: string, destination: string): boolean {
  return (
    statSync(source).isDirectory() ||
    !existsSync(destination) ||
    !readFileSync(source).equals(readFileSync(destination))
  );
}
