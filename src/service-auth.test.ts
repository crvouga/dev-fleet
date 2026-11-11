import { expect, test } from 'bun:test';
import { codingAuth, serviceAuth } from './service-auth';
import { toolchainChecks } from './toolchain-checks';
import { failure, success } from './test-fixtures';

test('Codex requires its explicit logged-in status and never retains API key output', async () => {
  const checks = await codingAuth('codex', async (command) => {
    expect(command).toEqual(['codex', 'login', 'status']);
    return {
      ...success(''),
      stderr: 'Logged in using an API key - private-secret',
    };
  });
  expect(checks[0]?.status).toBe('pass');
  expect(JSON.stringify(checks)).not.toContain('private-secret');
  expect(
    (await codingAuth('codex', async () => success('Usage: codex')))[0]?.status
  ).toBe('fail');
  expect(
    (await codingAuth('codex', async () => failure('private-secret')))[0]
      ?.status
  ).toBe('fail');
});

test('Claude requires loggedIn true in valid JSON, not a saved file or zero exit alone', async () => {
  for (const value of ['{}', '{"loggedIn":false}', 'not-json']) {
    expect(
      (await codingAuth('claude', async () => success(value)))[0]?.status
    ).toBe('fail');
  }
  const result = await codingAuth('claude', async (command) => {
    expect(command).toEqual(['claude', 'auth', 'status', '--json']);
    return success('{"loggedIn":true,"token":"private-secret"}');
  });
  expect(result[0]?.status).toBe('pass');
  expect(JSON.stringify(result)).not.toContain('private-secret');
});

test('missing service commands and unsupported coding-provider checks cannot certify authentication', async () => {
  const calls: string[][] = [];
  const checks = await serviceAuth(async (command) => {
    calls.push(command);
    return failure('private-secret');
  });
  expect(checks.filter((check) => check.status === 'fail')).toHaveLength(5);
  expect(
    checks.filter((check) => check.status === 'skip').map((check) => check.id)
  ).toEqual(['auth:gemini', 'auth:copilot', 'auth:opencode']);
  expect(calls.every((command) => !command.includes('login'))).toBe(true);
  expect(JSON.stringify(checks)).not.toContain('private-secret');
});

test('toolchain diagnostics preserve per-tool failures, exact expected versions and runtime warnings', async () => {
  const checks = await toolchainChecks('/repo', async (command) => {
    expect(command).toContain('--docker');
    return success(
      JSON.stringify({
        ok: true,
        checks: [
          { id: 'node', status: 'pass', detail: '26.13.0' },
          { id: 'bun', status: 'fail', detail: 'private-token' },
          { id: 'docker-engine', status: 'warn', detail: 'private-token' },
        ],
      })
    );
  });
  expect(checks.map((check) => check.status)).toEqual(['pass', 'fail', 'warn']);
  expect(checks[0]?.summary).toContain('26.13.0');
  expect(JSON.stringify(checks)).not.toContain('private-token');
  expect(
    (
      await toolchainChecks('/repo', async () =>
        success('{"ok":true,"checks":[]}')
      )
    )[0]?.status
  ).toBe('fail');
});

test('service adapters require successful explicit identities and never retain them', async () => {
  const responses: Record<string, string> = {
    railway: '{"id":"private-account"}',
    vercel: 'private-account\n',
    wrangler: '{"loggedIn":true,"token":"private-secret"}',
    aws: '{"Account":"private-account","Arn":"private-secret"}',
    npm: 'private-account\n',
  };
  const checks = await serviceAuth(async (command, options) => {
    expect(options?.timeoutMs).toBe(15_000);
    return success(responses[command[0]!]!);
  });
  expect(checks.filter((check) => check.status === 'pass')).toHaveLength(5);
  expect(JSON.stringify(checks)).not.toContain('private-account');
  expect(JSON.stringify(checks)).not.toContain('private-secret');
  const empty = await serviceAuth(async () => success('{}'));
  expect(empty.filter((check) => check.status === 'pass')).toHaveLength(0);
});
