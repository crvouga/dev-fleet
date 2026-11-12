import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The secrets fleet code needs, by what they are for. Where each one is kept
 * is the fleet's own choice, declared under `secrets` in its configuration.
 */
export const SECRET_NAMES = [
  'proxy-client-key',
  'monitoring-account-password',
  'monitoring-tunnel-token',
  'proxy-tunnel-token',
] as const;
/** Secrets a fleet may leave undeclared. A Vault fleet that names no location
 * for the GitHub token keeps it where dev-fleet always read it (see
 * `vaultLocation`); the others are needed only by a feature the fleet
 * declares, and are otherwise unavailable.
 */
export const OPTIONAL_SECRET_NAMES = [
  'github-token',
  // The off-machine storage of the monitoring hub's backups
  // (services.monitoring.backups).
  'monitoring-backup-access-key',
  'monitoring-backup-secret-key',
  // Where fleet-watch notifies (notify.targets).
  'notify-webhook-url',
  'notify-ntfy-url',
] as const;
export type SecretName =
  (typeof SECRET_NAMES)[number] | (typeof OPTIONAL_SECRET_NAMES)[number];

/** A secret's location in a Vault KV v2 mount. */
export type VaultLocation = { path: string; field: string };
export type SecretsConfig =
  | { provider: 'env' }
  | { provider: 'file'; directory?: string }
  | { provider: 'sops'; file: string }
  | {
      provider: 'vault';
      address: string;
      mount: string;
      locations: VaultLocations;
    };
export type VaultLocations = Record<
  (typeof SECRET_NAMES)[number],
  VaultLocation
> &
  Partial<Record<(typeof OPTIONAL_SECRET_NAMES)[number], VaultLocation>>;

/** Runs a command and returns its stdout, or null when it fails. */
export type SecretCommand = (
  argv: string[],
  env?: Record<string, string>
) => Promise<string | null>;

/** One read of one secret for this node. Null when it is not available; the
 * value is never logged, printed or placed in argv. `node` names a node's own
 * copy of a secret that is kept once per node (`secretVariant`).
 */
export type SecretsProvider = (
  name: SecretName,
  node?: string
) => Promise<string | null>;

const present = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

/** `proxy-client-key` is read from `DEVFLEET_SECRET_PROXY_CLIENT_KEY`. */
export const envName = (name: SecretName, node?: string): string =>
  `DEVFLEET_SECRET_${secretVariant(name, node).toUpperCase().replaceAll('-', '_')}`;

/** The name of a node's own copy of a secret: `github-token` of `worker-one`
 * is `github-token-worker-one` (`DEVFLEET_SECRET_GITHUB_TOKEN_WORKER_ONE`, the
 * file or sops key `github-token-worker-one`, the Vault field `FIELD_WORKER_ONE`).
 */
export const secretVariant = (name: SecretName, node?: string): string =>
  node ? `${name}-${node}` : name;

/** Where a Vault fleet keeps a secret. The GitHub token was always read from
 * the field `GITHUB_TOKEN` beside the proxy client key; a fleet that names no
 * location of its own keeps it there.
 */
export function vaultLocation(
  config: Extract<SecretsConfig, { provider: 'vault' }>,
  name: SecretName,
  node?: string
): VaultLocation | null {
  const location =
    config.locations[name as keyof typeof config.locations] ??
    (name === 'github-token'
      ? {
          path: config.locations['proxy-client-key'].path,
          field: 'GITHUB_TOKEN',
        }
      : null);
  if (!location) return null;
  return node
    ? {
        path: location.path,
        field: `${location.field}_${node.toUpperCase().replaceAll('-', '_')}`,
      }
    : location;
}

export function secretsProvider(
  config: SecretsConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: SecretCommand;
    home?: string;
  } = {}
): SecretsProvider {
  const env = options.env ?? process.env;
  const run = options.run ?? execute;
  if (config.provider === 'env')
    return async (name, node) => present(env[envName(name, node)]);
  if (config.provider === 'file') {
    // One private file per secret, named after it.
    const directory =
      config.directory ??
      join(options.home ?? homedir(), '.config/dev-fleet/secrets');
    return async (name, node) =>
      present(
        await readFile(
          join(directory, secretVariant(name, node)),
          'utf8'
        ).catch(() => null)
      );
  }
  if (config.provider === 'sops')
    // An age- (or KMS-) encrypted document with one top-level key per secret.
    return async (name, node) =>
      present(
        await run([
          'sops',
          '--decrypt',
          '--extract',
          `["${secretVariant(name, node)}"]`,
          config.file,
        ])
      );
  return async (name, node) => {
    const location = vaultLocation(config, name, node);
    if (!location) return null;
    return present(
      await run([
        'vault',
        'kv',
        'get',
        `-address=${config.address}`,
        `-mount=${config.mount}`,
        `-field=${location.field}`,
        location.path,
      ])
    );
  };
}

const execute: SecretCommand = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 65_536) output += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output : null));
  });

type Fields = Record<string, unknown>;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
const only = (value: Fields, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const PARSERS: Record<string, (value: Fields) => SecretsConfig | null> = {
  env: (value) => (only(value, ['provider']) ? { provider: 'env' } : null),
  file: (value) =>
    only(value, ['provider', 'directory']) &&
    (value['directory'] === undefined || text(value['directory']))
      ? {
          provider: 'file',
          ...(text(value['directory'])
            ? { directory: value['directory'] }
            : {}),
        }
      : null,
  sops: (value) =>
    only(value, ['provider', 'file']) && text(value['file'])
      ? { provider: 'sops', file: value['file'] }
      : null,
  vault: (value) => {
    const { address, mount } = value;
    const locations = vaultLocations(value['locations']);
    return only(value, ['provider', 'address', 'mount', 'locations']) &&
      text(address) &&
      /^https:\/\/[A-Za-z0-9.-]{1,253}$/.test(address) &&
      text(mount) &&
      locations
      ? { provider: 'vault', address, mount, locations }
      : null;
  },
};

function vaultLocations(value: unknown): VaultLocations | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Fields;
  if (!only(fields, [...SECRET_NAMES, ...OPTIONAL_SECRET_NAMES])) return null;
  const optional = OPTIONAL_SECRET_NAMES.filter((name) => name in fields);
  const valid = [...SECRET_NAMES, ...optional].every((name) => {
    const location = fields[name] as Fields | undefined;
    return (
      location !== null &&
      typeof location === 'object' &&
      only(location, ['path', 'field']) &&
      text(location['path']) &&
      text(location['field'])
    );
  });
  return valid ? (fields as VaultLocations) : null;
}

/** The `secrets` block of a fleet configuration, or null when it is invalid. */
export function parseSecretsConfig(value: unknown): SecretsConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Fields;
  return PARSERS[String(fields['provider'])]?.(fields) ?? null;
}
