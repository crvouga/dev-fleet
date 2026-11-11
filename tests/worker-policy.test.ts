import { expect, test } from 'bun:test';
import { workerTools } from '../bootstrap/worker-tools';
import { renewWorkerVault } from '../bootstrap/worker-auth';
import { syncWorkerGithub } from '../bootstrap/worker-github';
import type { AuthRunner } from '../bootstrap/worker-github';

const ids = ['bun', 'node', 'gh', 'python', 'uv', 'docker-cli', 'vault'];
test('minimal worker profile retains authoritative versions and rejects missing pins', () => {
  const tools = Object.fromEntries(
    [...ids, 'aws'].map((id) => [id, { version: '1.2.3' }])
  );
  expect(Object.keys(workerTools(tools, ids.join(',')))).toEqual(ids);
  expect(() => workerTools(tools, [...ids, 'unmanaged'])).toThrow();
  expect(() => workerTools(tools, ['bun'])).toThrow();
});
test('self-renewal requires a successful finite lease response and never exposes the token', () => {
  expect(
    renewWorkerVault(() => ({
      status: 0,
      stdout: JSON.stringify({
        auth: { client_token: 'PRIVATE_SENTINEL', lease_duration: 86400 },
      }),
    }))
  ).toBe(true);
  expect(
    renewWorkerVault(() => ({ status: 1, stdout: 'PRIVATE_SENTINEL' }))
  ).toBe(false);
  expect(renewWorkerVault(() => ({ status: 0, stdout: '{}' }))).toBe(false);
});
test('GitHub bootstrap validates the declared account before storing a Vault-sourced service token', () => {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const token = 'PRIVATE_SENTINEL_TOKEN';
  const run: AuthRunner = (args, options) => {
    calls.push({ args, input: options?.input });
    if (args[0] === 'vault') return { status: 0, stdout: token };
    if (options?.env?.['GH_TOKEN'])
      return { status: 0, stdout: 'example-user' };
    if (args.includes('login')) return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  expect(syncWorkerGithub(run)).toBe(true);
  expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(token);
  expect(calls.at(-1)?.input).toBe(token + '\n');
});
