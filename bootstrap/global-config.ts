/** Publish one managed global mise config without clobbering unrelated configuration. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARKER = '# Managed by dev-fleet bootstrap/setup.ts\n';
/**
 * Where agent harnesses create a fresh checkout per task. Every new path would
 * need its own `mise trust`, and an untrusted mise.toml makes every mise shim
 * (claude, codex, bun, ...) exit before the agent starts. mise honours this
 * setting only in the global config, so it is added at publish time and never
 * written into the repository's mise.toml.
 */
export const AGENT_WORKTREE_ROOTS = ['~/.t3/worktrees'];
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

/** What `publishGlobalConfig` writes to config.toml, given what is there. */
function publishedConfig(root: string, previous: string | undefined): string {
  return (
    MARKER +
    withTrustedPaths(
      readFileSync(join(root, 'mise.toml'), 'utf8'),
      trustedPaths(previous)
    )
  );
}

export function publishGlobalConfig(dir: string, root = workspaceRoot): void {
  assertManagedConfig(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.toml');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const config = publishedConfig(root, previous);
  if (previous !== config) writeFileSync(path, config);
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

/**
 * How the global mise configuration stands against what this revision
 * publishes. On a fleet machine it belongs to dev-fleet: a project pins its
 * tools in its own mise.toml and never publishes a global one.
 *
 * - `published`: dev-fleet's marker, this revision's pins and lock
 * - `missing`: there is no global config.toml
 * - `replaced`: another owner (or nobody's marker) wrote it
 * - `changed`: dev-fleet's marker, but not this revision's content
 */
export type GlobalConfigStanding =
  'published' | 'missing' | 'replaced' | 'changed';

export function globalConfigStanding(
  dir: string,
  root = workspaceRoot
): GlobalConfigStanding {
  const path = join(dir, 'config.toml');
  if (!existsSync(path)) return 'missing';
  const current = readFileSync(path, 'utf8');
  if (!current.startsWith(MARKER)) return 'replaced';
  const same = (source: string, target: string): boolean =>
    existsSync(target) && readFileSync(source).equals(readFileSync(target));
  const sidecars = join(root, '.mise/locks');
  const locks = existsSync(sidecars)
    ? (readdirSync(sidecars, { recursive: true }) as string[])
        .map((name) => join('.mise/locks', name))
        .filter((name) => statSync(join(root, name)).isFile())
    : [];
  // Paths trusted on the machine are kept by every publish, in any order;
  // the agent worktree roots must be among them.
  const TRUSTED = /^trusted_config_paths\s*=.*\n/m;
  const trusted = trustedPaths(current);
  let listed: unknown;
  try {
    listed = (Bun.TOML.parse(current) as { settings?: Record<string, unknown> })
      .settings?.['trusted_config_paths'];
  } catch {
    listed = undefined;
  }
  const unchanged =
    Array.isArray(listed) &&
    trusted.every((path) => listed.includes(path)) &&
    current.replace(TRUSTED, '') ===
      publishedConfig(root, current).replace(TRUSTED, '') &&
    ['mise.lock', ...locks].every((name) =>
      same(join(root, name), join(dir, name))
    );
  return unchanged ? 'published' : 'changed';
}

/**
 * The managed roots plus any entries already in the published config, so a
 * local `mise settings add trusted_config_paths ...` survives the next publish.
 */
export function trustedPaths(previous: string | undefined): string[] {
  let local: unknown;
  try {
    local = previous
      ? (Bun.TOML.parse(previous) as { settings?: Record<string, unknown> })
          .settings?.['trusted_config_paths']
      : undefined;
  } catch {
    local = undefined;
  }
  const extra = Array.isArray(local)
    ? local.filter((path): path is string => typeof path === 'string')
    : [];
  return [...new Set([...AGENT_WORKTREE_ROOTS, ...extra])];
}

/** Adds trusted_config_paths to the [settings] table, creating it if absent. */
export function withTrustedPaths(config: string, paths: string[]): string {
  const line = `trusted_config_paths = [${paths.map((path) => JSON.stringify(path)).join(', ')}]`;
  if (/^trusted_config_paths\s*=/m.test(config))
    throw new Error(
      'mise.toml sets trusted_config_paths; mise ignores it outside the global config. Add roots to AGENT_WORKTREE_ROOTS instead.'
    );
  const header = /^\[settings\][^\S\n]*\n/m;
  return header.test(config)
    ? config.replace(header, (match) => `${match}${line}\n`)
    : `${config.replace(/\n*$/, '\n')}\n[settings]\n${line}\n`;
}

function changedFile(source: string, destination: string): boolean {
  return (
    statSync(source).isDirectory() ||
    !existsSync(destination) ||
    !readFileSync(source).equals(readFileSync(destination))
  );
}
