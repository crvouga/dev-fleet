/** Acquire declared service credentials from this worker's Vault session; never copy a login directory. */
import { spawnSync } from 'node:child_process';
import { resolveVaultConfig, usesVault } from '../src/vault-config';
import { fleet as definition } from '../src/fleet-config';

export type AuthRunner = (
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv }
) => { status: number | null; stdout: string | null };
const execute: AuthRunner = (args, options = {}) =>
  spawnSync(args[0]!, args.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
export function syncWorkerGithub(run: AuthRunner = execute): boolean {
  const expected = definition.worker!.githubLogin;
  const current = run(['gh', 'api', 'user', '--jq', '.login']);
  if (current.status === 0 && current.stdout?.trim() === expected) return true;
  // The service token is kept in the shared Vault document only.
  if (!usesVault()) return false;
  const { addr, mount, project, config } = resolveVaultConfig();
  const secret = run([
    'vault',
    'kv',
    'get',
    `-address=${addr}`,
    '-field=GITHUB_TOKEN',
    `${mount}/${project}/${config}`,
  ]);
  const token = secret.stdout?.trim() ?? '';
  if (secret.status !== 0 || !/^[\x21-\x7e]{16,4096}$/.test(token))
    return false;
  const validated = run(['gh', 'api', 'user', '--jq', '.login'], {
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: undefined },
  });
  if (validated.status !== 0 || validated.stdout?.trim() !== expected)
    return false;
  const login = run(
    ['gh', 'auth', 'login', '--hostname', 'github.com', '--with-token'],
    {
      input: token + '\n',
      env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
    }
  );
  return login.status === 0;
}
