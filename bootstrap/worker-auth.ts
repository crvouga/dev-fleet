import { syncWorkerGithub } from './worker-github';
/** Private scheduled job. The worker retains its own token; raw auth output is never logged. */
import { spawnSync } from 'node:child_process';
import { resolveVaultConfig, usesVault } from '../src/vault-config';

export function renewWorkerVault(
  run: (args: string[]) => { status: number | null; stdout: string | null } = (
    args: string[]
  ) => spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', timeout: 30_000 })
): boolean {
  if (!usesVault()) return true;
  const { addr } = resolveVaultConfig();
  const result = run([
    'vault',
    'token',
    'renew',
    `-address=${addr}`,
    '-format=json',
    '-increment=24h',
  ]);
  if (result.status !== 0) return false;
  try {
    const data: unknown = JSON.parse(result.stdout ?? '');
    return (
      typeof data === 'object' &&
      data !== null &&
      'auth' in data &&
      typeof data.auth === 'object' &&
      data.auth !== null &&
      'lease_duration' in data.auth &&
      typeof data.auth.lease_duration === 'number' &&
      data.auth.lease_duration > 0
    );
  } catch {
    return false;
  }
}
if (import.meta.main) {
  // One JSON line per event; never a token or raw auth output.
  const log = {
    info: (event: string, fields: Record<string, unknown>) =>
      process.stdout.write(
        JSON.stringify({ name: 'dev-fleet-worker-auth', event, ...fields }) +
          '\n'
      ),
  };
  const started = Date.now();
  log.info('job_started', {
    jobId: 'vault-self-renewal',
    operation: 'vault.token.renew',
  });
  const vault = renewWorkerVault();
  const github = vault && syncWorkerGithub();
  const ok = vault && github;
  log.info('job_finished', {
    jobId: 'vault-self-renewal',
    operation: 'vault.token.renew',
    vaultAuthenticated: vault,
    githubAuthenticated: github,
    outcome: ok ? 'success' : 'authentication_required',
    durationMs: Date.now() - started,
    retryDelayMs: 600000,
  });
  process.exitCode = ok ? 0 : 1;
}
