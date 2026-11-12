import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleet as definition } from '../fleet-config';
import { sshArgs, shellQuote } from '../ssh';
import { resolveVaultConfig, usesVault } from '../vault-config';
import { workerTokenLocation } from '../worker-credentials';
import { runAnsible } from '../platform/ansible';
import type { Check, FleetNode, Runner } from '../types';

const TOOL_PATH =
  'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"';

/** Runs an interactive command with the operator's terminal attached. */
export type TerminalRunner = (args: string[]) => boolean;

const terminal: TerminalRunner = (args) =>
  spawnSync(args[0]!, args.slice(1), { stdio: 'inherit' }).status === 0;

type VaultState = 'authenticated' | 'unauthenticated' | 'unavailable';

/** The field of the fleet's shared document that held a worker's token
 * before each worker had a document of its own (src/worker-credentials.ts).
 * Read only when the worker's own document holds none, and reported: every
 * worker that can read the shared document can read that field.
 */
export function workerTokenField(node: string): string {
  return `FLEET_WORKER_TOKEN_${node.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * The manager reads each node's own token from Vault, so it must be logged in
 * first. Interactive runs prompt once on this terminal; the password never
 * passes through this process.
 */
export async function authorizeManager(
  options: { interactive: boolean },
  run: Runner,
  attach: TerminalRunner = terminal
): Promise<boolean> {
  if (!usesVault()) return true;
  if ((await run(lookup(), { timeoutMs: 20_000 })).ok) return true;
  if (!options.interactive) return false;
  process.stderr.write(
    'This manager is not logged in to Vault. Log in once; each machine then gets its own token.\n'
  );
  attach(login());
  return (await run(lookup(), { timeoutMs: 20_000 })).ok;
}

/**
 * Each node keeps its own periodic Vault token (renewed by the worker job). The
 * proxy key, GitHub token and provider credentials all come from that session,
 * so a node without one has no working proxy providers. The node's
 * issued token is delivered once over SSH stdin, never as an argument;
 * interactive runs fall back to a password login on the node's own terminal.
 */
export async function authorizeVault(
  node: FleetNode,
  options: {
    interactive: boolean;
    /** Opt-in: the fleet's shared Vault user, typed on the worker's own
     * terminal, when no token of its own was issued.
     */
    passwordLogin?: boolean;
  },
  run: Runner,
  attach: TerminalRunner = terminal
): Promise<Check[]> {
  // The other secrets providers need no per-node session.
  if (!usesVault()) return [];
  const before = await vaultState(node, run);
  if (before === 'authenticated') return [pass(node)];
  // Fresh node: the locked toolchain (including vault) is not installed yet.
  if (before === 'unavailable') return [];
  const delivered = await deliverWorkerToken(node, run);
  if (delivered === 'own') return [pass(node)];
  if (delivered === 'shared') return [pass(node), shared(node)];
  if (!options.interactive || !options.passwordLogin) return [required(node)];
  process.stderr.write(
    `[${node.id}] No issued worker token found. Enter the Vault password to log this machine in.\n`
  );
  attach(remote(node, login(), '-t'));
  return [
    (await vaultState(node, run)) === 'authenticated'
      ? pass(node)
      : required(node),
  ];
}

/** Delivers the worker's token, from its own document or else from the
 * field it used to have in the shared one; says which, or that none was.
 */
async function deliverWorkerToken(
  node: FleetNode,
  run: Runner
): Promise<'own' | 'shared' | null> {
  const vault = resolveVaultConfig();
  const own = workerTokenLocation(node.id, vault);
  const sources = [
    { from: 'own' as const, ...own },
    {
      from: 'shared' as const,
      mount: vault.mount,
      path: `${vault.project}/${vault.config}`,
      field: workerTokenField(node.id),
    },
  ];
  for (const source of sources) {
    const secret = await run(
      [
        'vault',
        'kv',
        'get',
        `-address=${vault.addr}`,
        `-mount=${source.mount}`,
        `-field=${source.field}`,
        source.path,
      ],
      { timeoutMs: 20_000 }
    );
    const token = secret.ok ? secret.stdout.trim() : '';
    if (!/^[\x21-\x7e]{16,4096}$/.test(token)) continue;
    const delivered = await run(
      remote(node, [
        'vault',
        'login',
        `-address=${vault.addr}`,
        '-no-print',
        '-',
      ]),
      { input: token + '\n', timeoutMs: 30_000 }
    );
    return delivered.ok && (await vaultState(node, run)) === 'authenticated'
      ? source.from
      : null;
  }
  return null;
}

async function vaultState(node: FleetNode, run: Runner): Promise<VaultState> {
  const result = await run(
    [
      ...sshArgs(node),
      `${TOOL_PATH}; command -v vault >/dev/null 2>&1 || { printf vault-missing; exit 1; }; ${quote(lookup())} >/dev/null 2>&1`,
    ],
    { timeoutMs: 20_000 }
  );
  if (result.ok) return 'authenticated';
  // Unreachable nodes are reported by the bootstrap's own SSH checks.
  if (result.reason !== 'exit') return 'unavailable';
  return result.stdout.includes('vault-missing')
    ? 'unavailable'
    : 'unauthenticated';
}

function lookup(): string[] {
  const { addr } = resolveVaultConfig();
  return ['vault', 'token', 'lookup', `-address=${addr}`, '-format=json'];
}

function login(): string[] {
  const { addr } = resolveVaultConfig();
  return [
    'vault',
    'login',
    `-address=${addr}`,
    '-method=userpass',
    '-no-print',
    `username=${definition.worker!.vaultUser}`,
  ];
}

/** Same verified connection options; `-t` attaches a terminal for prompts. */
export function remote(
  node: FleetNode,
  command: string[],
  tty: '-T' | '-t' = '-T'
): string[] {
  const args = sshArgs(node).map((arg) => (arg === '-T' ? tty : arg));
  return [...args, `${TOOL_PATH}; ${quote(command)}`];
}

function quote(command: string[]): string {
  return command.map(shellQuote).join(' ');
}

function pass(node: FleetNode): Check {
  return {
    id: 'auth:vault',
    status: 'pass',
    summary: `${node.id} has its own Vault session; proxy providers can read their key.`,
  };
}

function shared(node: FleetNode): Check {
  const own = workerTokenLocation(node.id);
  return {
    id: 'auth:vault-isolation',
    status: 'warn',
    summary: 'VAULT_WORKER_TOKEN_SHARED',
    remedy: {
      action: `${node.id}'s token was read from the fleet's shared document, which every worker can read. Issue it a token of its own with devfleet fleet-node-replace --id ${node.id} --apply --yes (kept at ${own.mount}/${own.path}), then remove ${workerTokenField(node.id)} from the shared document.`,
    },
  };
}

function required(node: FleetNode): Check {
  const { addr } = resolveVaultConfig();
  return {
    id: 'auth:vault',
    status: 'fail',
    summary: 'VAULT_LOGIN_REQUIRED',
    remedy: {
      action: `Issue ${node.id} a token of its own with devfleet fleet-node-replace --id ${node.id} --apply --yes. Opt-in fallback: devfleet fleet-sync --vault-password-login in a terminal, or on ${node.id}: vault login -address=${addr} -method=userpass username=${definition.worker!.vaultUser}. Proxy providers in T3 stay unavailable until then.`,
    },
  };
}

/**
 * The manager's own Vault session renews itself every ten minutes, like each
 * worker's: `ansible/macos/vault-renew.yml`, applied on every applying sync.
 * Measured as the session answering and the job being loaded; a lapsed
 * session needs one login by a person, and until then agents on the manager
 * use the proxy client key they last read (src/agents/secrets.ts).
 */
export async function holdManagerVault(
  run: Runner,
  options: {
    apply: boolean;
    root: string;
    home?: string;
    uid?: number;
    scratch?: string;
  }
): Promise<Check[]> {
  if (!usesVault()) return [];
  const { addr } = resolveVaultConfig();
  const home = options.home ?? homedir();
  if (options.apply)
    await runAnsible(
      run,
      join(options.root, 'ansible/macos/vault-renew.yml'),
      {
        input: JSON.stringify({
          vault_address: addr,
          mise: join(home, '.local/bin/mise'),
        }),
        timeoutMs: 120_000,
      },
      options.scratch
    );
  const loaded = (
    await run(
      [
        'launchctl',
        'print',
        `gui/${options.uid ?? process.getuid?.() ?? 0}/${MANAGER_VAULT_RENEWAL}`,
      ],
      { timeoutMs: 10_000 }
    )
  ).ok;
  const session = (await run(lookup(), { timeoutMs: 20_000 })).ok;
  return [vaultRenewalCheck(session, loaded, addr)];
}

function vaultRenewalCheck(
  session: boolean,
  loaded: boolean,
  addr: string
): Check {
  if (session && loaded)
    return {
      id: 'manager:vault-renewal',
      status: 'pass',
      summary:
        'The manager is logged in to Vault and renews its session every ten minutes.',
    };
  return {
    id: 'manager:vault-renewal',
    status: 'fail',
    summary: session ? 'VAULT_RENEWAL_MISSING' : 'VAULT_LOGIN_REQUIRED',
    remedy: {
      action: session
        ? `The manager's Vault session is not renewed and lapses at its TTL. Run devfleet fleet-sync on the manager; it loads ${MANAGER_VAULT_RENEWAL}.`
        : `Log the manager in once, in your own terminal: vault login -address=${addr} -method=userpass username=${definition.worker?.vaultUser ?? 'YOUR_USERNAME'}. Then run devfleet fleet-sync. Until then the manager's agents use the proxy client key they last read, and new worker tokens cannot be issued.`,
    },
  };
}

/** The launchd label of the manager's Vault renewal job (vault-renew.yml). */
export const MANAGER_VAULT_RENEWAL = 'dev.devfleet.vault-renew';
