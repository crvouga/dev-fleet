import { fleet } from './fleet-config';
import { resolveVaultConfig, type VaultConfig } from './vault-config';
import type { Check, Runner } from './types';

/** Each worker's own Vault token is kept in a document of its own, beside
 * the fleet's shared one: `<project>/workers/<id>`, field `token`, with the
 * token's `accessor` so the manager can revoke it without holding it. A
 * policy that grants one worker its document grants it nothing of another's.
 */
export interface WorkerTokenLocation {
  mount: string;
  path: string;
  field: 'token';
}

export function workerTokenLocation(
  node: string,
  vault: VaultConfig = resolveVaultConfig()
): WorkerTokenLocation {
  return {
    mount: vault.mount,
    path: `${vault.project}/workers/${node}`,
    field: 'token',
  };
}

/** The Vault policy each worker token is issued with. */
export const workerPolicyName = (node: string): string =>
  `fleet-worker-${node}`;

/** The least a worker needs: the fleet's shared document (the proxy key and
 * what the providers read) and its own token document. Nothing grants a
 * worker the documents of the others, so one worker's token cannot read
 * another's. Token renewal and lookup come from Vault's default policy.
 */
export function workerVaultPolicy(
  node: string,
  vault: VaultConfig = resolveVaultConfig(),
  shared: string = sharedDocument()
): string {
  const own = workerTokenLocation(node, vault);
  return [
    `# dev-fleet: the policy of the worker ${node}. Written by dev-fleet; do not edit.`,
    `path "${vault.mount}/data/${shared}" {`,
    '  capabilities = ["read"]',
    '}',
    `path "${own.mount}/data/${own.path}" {`,
    '  capabilities = ["read"]',
    '}',
    '',
  ].join('\n');
}

function sharedDocument(): string {
  const secrets = fleet.secrets;
  return secrets.provider === 'vault'
    ? secrets.locations['proxy-client-key'].path
    : '';
}

const TIMEOUT = { timeoutMs: 20_000 };

/** Issues a worker its own periodic, orphan token under its own policy and
 * keeps it in its own document. The token reaches `vault kv put` on standard
 * input, never as an argument. Run on the manager, logged in to Vault.
 */
export async function issueWorkerToken(
  node: string,
  run: Runner,
  vault: VaultConfig = resolveVaultConfig()
): Promise<Check> {
  const address = `-address=${vault.addr}`;
  const policy = await run(
    ['vault', 'policy', 'write', address, workerPolicyName(node), '-'],
    { ...TIMEOUT, input: workerVaultPolicy(node, vault) }
  );
  if (!policy.ok) return credentialFailure('VAULT_WORKER_POLICY_FAILED');
  const created = await run(
    [
      'vault',
      'token',
      'create',
      address,
      `-policy=${workerPolicyName(node)}`,
      '-orphan',
      '-period=768h',
      `-display-name=${workerPolicyName(node)}`,
      '-format=json',
    ],
    TIMEOUT
  );
  const issued = created.ok ? parseIssued(created.stdout) : null;
  if (!issued) return credentialFailure('VAULT_WORKER_TOKEN_NOT_ISSUED');
  const location = workerTokenLocation(node, vault);
  const stored = await run(
    [
      'vault',
      'kv',
      'put',
      address,
      `-mount=${location.mount}`,
      location.path,
      'token=-',
      `accessor=${issued.accessor}`,
    ],
    { ...TIMEOUT, input: issued.token }
  );
  if (!stored.ok) return credentialFailure('VAULT_WORKER_TOKEN_NOT_STORED');
  return {
    id: 'auth:worker-token',
    status: 'pass',
    summary: `${node} has a token of its own, readable by nothing but itself and the manager.`,
  };
}

function parseIssued(
  stdout: string
): { token: string; accessor: string } | null {
  try {
    const auth = (JSON.parse(stdout) as { auth?: Record<string, unknown> })
      .auth;
    const token = auth?.['client_token'];
    const accessor = auth?.['accessor'];
    return typeof token === 'string' &&
      typeof accessor === 'string' &&
      /^[\x21-\x7e]{16,4096}$/.test(token) &&
      /^[A-Za-z0-9._-]{8,256}$/.test(accessor)
      ? { token, accessor }
      : null;
  } catch {
    return null;
  }
}

/** Revokes a worker's token by its accessor (the manager never holds the
 * token to do so), then removes its document and its policy. A worker that
 * has none already is revoked: running it twice changes nothing.
 */
export async function revokeWorkerToken(
  node: string,
  run: Runner,
  vault: VaultConfig = resolveVaultConfig()
): Promise<Check> {
  const address = `-address=${vault.addr}`;
  const location = workerTokenLocation(node, vault);
  const read = await run(
    [
      'vault',
      'kv',
      'get',
      address,
      `-mount=${location.mount}`,
      '-field=accessor',
      location.path,
    ],
    TIMEOUT
  );
  const accessor = read.ok ? read.stdout.trim() : '';
  if (accessor) {
    if (!/^[A-Za-z0-9._-]{8,256}$/.test(accessor))
      return credentialFailure('VAULT_WORKER_TOKEN_NOT_REVOKED');
    const revoked = await run(
      ['vault', 'token', 'revoke', address, '-accessor', accessor],
      TIMEOUT
    );
    if (!revoked.ok) return credentialFailure('VAULT_WORKER_TOKEN_NOT_REVOKED');
  }
  await run(
    [
      'vault',
      'kv',
      'metadata',
      'delete',
      address,
      `-mount=${location.mount}`,
      location.path,
    ],
    TIMEOUT
  );
  await run(
    ['vault', 'policy', 'delete', address, workerPolicyName(node)],
    TIMEOUT
  );
  return {
    id: 'auth:worker-token',
    status: 'pass',
    summary: `${node}'s token is revoked and its document and policy removed.`,
  };
}

function credentialFailure(summary: string): Check {
  return {
    id: 'auth:worker-token',
    status: 'fail',
    summary,
    remedy: {
      action:
        'Log the manager in to Vault with a token that may write policies, issue tokens and write the fleet mount, then run the command again.',
    },
  };
}
