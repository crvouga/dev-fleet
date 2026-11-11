import type { Check, Runner } from './types';
import { fleet, secretVia } from './fleet-config';
import { registry } from './agents/registry';
import { resolveVaultConfig, usesVault } from './vault-config';
import { record } from './config';

/** Inject every subprocess; never put credentials in argv, reports, or logs. */
export async function workerAccessChecks(run: Runner): Promise<Check[]> {
  const policy = fleet.worker!;
  const github = await run(['gh', 'api', 'user', '--jq', '.login']);
  return [
    {
      id: 'worker:github-principal',
      status:
        github.ok && github.stdout.trim() === policy.githubLogin
          ? 'pass'
          : 'fail',
      summary:
        'Worker GitHub authentication must match the declared common account.',
      remedy: {
        action:
          'Authenticate this worker with the declared GitHub account. Credentials stay on their original machines.',
      },
    },
    await proxyAuthentication(run),
    ...(usesVault() ? [await vaultRenewalCheck(run)] : []),
  ];
}
async function proxyAuthentication(run: Runner): Promise<Check> {
  const unavailable: Check = {
    id: 'worker:proxy-authentication',
    status: 'fail',
    summary: 'UNATTENDED_PROXY_AUTHENTICATION_REQUIRED',
    remedy: {
      action:
        'Restore this worker’s own Vault authorization and renewal; no other node’s login or gateway identity is copied.',
    },
  };
  try {
    const key = (await secretVia(run)('proxy-client-key')) ?? '';
    if (!/^[\x21-\x7e]{16,4096}$/.test(key)) return unavailable;
    const result = await run(
      [
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--header',
        '@-',
        `${registry.proxy.endpoint}/v1/models`,
      ],
      { input: `Authorization: Bearer ${key}\n`, timeoutMs: 15_000 }
    );
    const data: unknown = JSON.parse(result.stdout);
    if (
      !result.ok ||
      !record(data) ||
      !Array.isArray(data['data']) ||
      !data['data'].length
    )
      return unavailable;
    return {
      ...unavailable,
      status: 'pass',
      summary:
        'Worker credential authenticates to the declared singleton gateway model catalog.',
    };
  } catch {
    return unavailable;
  }
}

async function vaultRenewalCheck(run: Runner): Promise<Check> {
  const unavailable: Check = {
    id: 'worker:vault-renewal',
    status: 'fail',
    summary: 'UNATTENDED_VAULT_IDENTITY_REQUIRED',
    remedy: {
      action:
        'Enroll this worker’s own periodic token or auto-auth identity. Ordinary expiring user sessions are not evidence of unattended renewal; no credentials are copied between machines.',
    },
  };
  try {
    const { addr } = resolveVaultConfig();
    const result = await run([
      'vault',
      'token',
      'lookup',
      `-address=${addr}`,
      '-format=json',
    ]);
    const data: unknown = JSON.parse(result.stdout);
    if (!result.ok || !record(data) || !record(data['data']))
      return unavailable;
    const token = data['data'];
    if (
      token['renewable'] !== true ||
      typeof token['period'] !== 'number' ||
      token['period'] <= 0 ||
      typeof token['ttl'] !== 'number' ||
      token['ttl'] <= 1200
    )
      return unavailable;
    return {
      ...unavailable,
      status: 'pass',
      summary:
        'This worker has a renewable periodic Vault identity with sufficient lifetime for the renewal timer.',
    };
  } catch {
    return unavailable;
  }
}
