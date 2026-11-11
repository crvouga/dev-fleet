import { spawnSync } from 'node:child_process';
import { fleet as definition } from '../fleet-config';
import { sshArgs, shellQuote } from '../ssh';
import { resolveVaultConfig, usesVault } from '../vault-config';
import type { Check, FleetNode, Runner } from '../types';

const TOOL_PATH =
  'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"';

/** Runs an interactive command with the operator's terminal attached. */
export type TerminalRunner = (args: string[]) => boolean;

const terminal: TerminalRunner = (args) =>
  spawnSync(args[0]!, args.slice(1), { stdio: 'inherit' }).status === 0;

type VaultState = 'authenticated' | 'unauthenticated' | 'unavailable';

/** Vault field holding the issued token for one worker node. */
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
  options: { interactive: boolean },
  run: Runner,
  attach: TerminalRunner = terminal
): Promise<Check[]> {
  // The other secrets providers need no per-node session.
  if (!usesVault()) return [];
  const before = await vaultState(node, run);
  if (before === 'authenticated') return [pass(node)];
  // Fresh node: the locked toolchain (including vault) is not installed yet.
  if (before === 'unavailable') return [];
  if (await deliverWorkerToken(node, run)) return [pass(node)];
  if (!options.interactive) return [required(node)];
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

async function deliverWorkerToken(
  node: FleetNode,
  run: Runner
): Promise<boolean> {
  const { addr, mount, project, config } = resolveVaultConfig();
  const secret = await run(
    [
      'vault',
      'kv',
      'get',
      `-address=${addr}`,
      `-mount=${mount}`,
      `-field=${workerTokenField(node.id)}`,
      `${project}/${config}`,
    ],
    { timeoutMs: 20_000 }
  );
  const token = secret.ok ? secret.stdout.trim() : '';
  if (!/^[\x21-\x7e]{16,4096}$/.test(token)) return false;
  const delivered = await run(
    remote(node, ['vault', 'login', `-address=${addr}`, '-no-print', '-']),
    { input: token + '\n', timeoutMs: 30_000 }
  );
  return delivered.ok && (await vaultState(node, run)) === 'authenticated';
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

function required(node: FleetNode): Check {
  const { addr } = resolveVaultConfig();
  return {
    id: 'auth:vault',
    status: 'fail',
    summary: 'VAULT_LOGIN_REQUIRED',
    remedy: {
      action: `Run devfleet fleet-sync in a terminal, or store this node's token in the shared Vault document as ${workerTokenField(node.id)}. Manual fallback on ${node.id}: vault login -address=${addr} -method=userpass username=${definition.worker!.vaultUser}. Proxy providers in T3 stay unavailable until then.`,
    },
  };
}
