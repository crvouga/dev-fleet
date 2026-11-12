import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { MachineDefinition } from './definition';
import { FleetUsageError } from './errors';
import { PACKAGE_ROOT } from './package-info';
import type { Runner } from './types';

/** What a new worker's first boot needs, and nothing that outlives it: the
 * worker account with the manager's public key, the privilege rule
 * fleet-sync expects, a host key generated here so the manager pins it before
 * the machine ever answers (no trust on first use), and a short-lived,
 * single-use Tailscale auth key that is deleted once the machine has joined.
 */
export interface SeedInput {
  worker: MachineDefinition;
  /** The manager's SSH public key: one line of a `.pub` file. */
  managerKey: string;
  /** From the secrets provider, by purpose (`tailnet-auth-key`). */
  authKey: string;
  /** Generated with ssh-keygen for this seed. */
  hostKey: { private: string; public: string };
  /** `tailscale` in ansible/ubuntu/policy.json: version and key digest. */
  tailscale: { version: string; keySha256: string };
  /** The codename of the fleet's Ubuntu release, from the Ubuntu policy. */
  codename: string;
  /** A self-hosted control server the machine joins; the hosted Tailscale's
   * when absent.
   */
  loginServer?: string;
}

/** The login server the Tailscale client uses when it is told none. */
const TAILSCALE_LOGIN_SERVER = 'https://controlplane.tailscale.com';

const PUBLIC_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{16,}( [^\n]*)?$/;

/** The user data of one worker: bootstrap/worker-seed.yaml with every
 * `${NAME}` filled. Values replace whole placeholders inside parsed strings,
 * so none of them can change the document's structure.
 */
export async function seedUserData(
  input: SeedInput,
  root = PACKAGE_ROOT
): Promise<Record<string, unknown>> {
  const { worker } = input;
  const user = worker.network?.user;
  if (!user)
    throw new FleetUsageError(
      `${worker.id} declares no network block; the seed needs its user and Tailscale name.`
    );
  if (!PUBLIC_KEY.test(input.managerKey.trim()))
    throw new FleetUsageError(
      'The manager public key is not one OpenSSH public key line.'
    );
  // A Headscale key has no fixed prefix; the hosted Tailscale's does.
  if (
    !(
      input.loginServer
        ? /^[A-Za-z0-9_-]{16,256}$/
        : /^tskey-auth-[A-Za-z0-9-]{8,200}$/
    ).test(input.authKey)
  )
    throw new FleetUsageError(
      'The tailnet-auth-key secret is not a Tailscale auth key (tskey-auth-…). Use a short-lived, single-use, tagged key.'
    );
  const values: Record<string, string> = {
    HOSTNAME: worker.network!.tailscaleName.split('.')[0]!,
    USER: user,
    MANAGER_KEY: input.managerKey.trim(),
    HOST_KEY_PRIVATE: input.hostKey.private,
    HOST_KEY_PUBLIC: input.hostKey.public,
    AUTH_KEY: input.authKey,
    TAILSCALE_VERSION: input.tailscale.version,
    TAILSCALE_KEY_SHA256: input.tailscale.keySha256,
    CODENAME: input.codename,
    LOGIN_SERVER: input.loginServer ?? TAILSCALE_LOGIN_SERVER,
  };
  const template = parse(
    await readFile(join(root, 'bootstrap/worker-seed.yaml'), 'utf8')
  ) as unknown;
  return fill(template, values) as Record<string, unknown>;
}

function fill(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const found = values[name];
      if (found === undefined)
        throw new Error(`The seed template names an unknown value ${name}.`);
      return found;
    });
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, values)])
    );
  return value;
}

/** Cloud-init user data, or an Ubuntu autoinstall file that carries it. */
export function renderSeed(
  userData: Record<string, unknown>,
  autoinstall: boolean
): string {
  const document = autoinstall
    ? {
        autoinstall: {
          version: 1,
          ssh: { 'install-server': true, 'allow-pw': false },
          'user-data': userData,
        },
      }
    : userData;
  return `#cloud-config\n${stringify(document, { lineWidth: 0 })}`;
}

/** The version and key digest the worker baseline pins for Tailscale. */
export async function tailscalePins(
  root = PACKAGE_ROOT
): Promise<SeedInput['tailscale']> {
  const policy = JSON.parse(
    await readFile(join(root, 'ansible/ubuntu/policy.json'), 'utf8')
  ) as { tailscale: SeedInput['tailscale'] };
  return policy.tailscale;
}

/** A new ed25519 host key, generated in a private directory that is removed
 * afterwards.
 */
export async function generateHostKey(
  id: string,
  run: Runner
): Promise<SeedInput['hostKey']> {
  const directory = await mkdtemp(join(tmpdir(), 'devfleet-seed-'));
  try {
    const path = join(directory, 'host');
    const made = await run(
      ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', id, '-f', path],
      { timeoutMs: 20_000 }
    );
    if (!made.ok)
      throw new FleetUsageError('ssh-keygen could not make a host key.');
    return {
      private: await readFile(path, 'utf8'),
      public: (await readFile(`${path}.pub`, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
