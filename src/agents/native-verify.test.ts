import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Runner } from '../types';
import { NATIVE_AGENTS, parsePins, verifyNativeAgents } from './native-verify';

const workspace = resolve(import.meta.dir, '../..');
// Unwritable: tests never read or record cached verification.
const NO_CACHE = { directory: '/dev/null/verify' };

test('every native agent is pinned in the shared toolchain', async () => {
  const pins = parsePins(
    await readFile(resolve(workspace, 'mise.toml'), 'utf8')
  );
  for (const agent of NATIVE_AGENTS) expect(pins[agent.pin]).toBeTruthy();
  expect(pins['http:grok']).toBe('1.0.77');
  expect(pins['claude']).toMatch(/^\d+\.\d+\.\d+$/);
});

function fake(
  answer: (args: string[]) => { ok: boolean; stdout: string; stderr?: string }
) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    const { ok, stdout, stderr = '' } = answer(args);
    return { ok, stdout, stderr, reason: 'exit' };
  };
  return { run, calls };
}

test('matching versions and signed-in launchers pass', async () => {
  const pins = parsePins(
    await readFile(resolve(workspace, 'mise.toml'), 'utf8')
  );
  const { run, calls } = fake((args) => {
    if (args[1] === '--version') {
      const agent = NATIVE_AGENTS.find((a) => a.binary === args[0])!;
      return { ok: true, stdout: `tool ${pins[agent.pin]}\n` };
    }
    return { ok: true, stdout: args.includes('models') ? 'auto\n' : 'OK\n' };
  });
  const checks = await verifyNativeAgents('node-a', workspace, run, {
    cache: NO_CACHE,
  });
  expect(checks).toHaveLength(NATIVE_AGENTS.length * 2);
  expect(checks.every((check) => check.status === 'pass')).toBe(true);
  const launches = calls.filter((args) => args[0] === 'bun');
  expect(launches.map((args) => args[1]!.split('/').pop()).sort()).toEqual(
    NATIVE_AGENTS.map((agent) => agent.wrapper).sort()
  );
});

test('a version drift or missing Vault session fails with a stable code only', async () => {
  const { run } = fake((args) => {
    if (args[1] === '--version') return { ok: true, stdout: 'tool 0.0.0' };
    if (args[1]!.endsWith('grok-proxy.ts'))
      return {
        ok: false,
        stdout: '',
        stderr:
          'Required secret unavailable: secret/data/personal/prd CLIPROXY_FLEET_CLIENT_API_KEY. raw-detail',
      };
    if (args[1]!.endsWith('antigravity-proxy.ts'))
      return {
        ok: false,
        stdout: '',
        stderr: 'unknown provider for model gemini-3.8-flash',
      };
    return { ok: true, stdout: 'OK' };
  });
  const checks = await verifyNativeAgents('node-a', workspace, run, {
    cache: NO_CACHE,
  });
  const get = (id: string) => {
    const check = checks.find((entry) => entry.id === id);
    if (!check) throw new Error(`missing ${id}`);
    return {
      summary: check.summary,
      status: check.status,
      action: check.remedy?.action ?? '',
    };
  };
  expect(get('agent:grok:version').summary).toBe('AGENT_VERSION_MISMATCH');
  expect(get('agent:grok:version').action).toContain('mise install');
  expect(get('agent:grok:session').summary).toBe('AGENT_VAULT_UNAVAILABLE');
  expect(get('agent:antigravity:session').summary).toBe('AGENT_MODEL_UNSERVED');
  expect(get('agent:antigravity:session').action).toContain(
    'proxy:config-pending'
  );
  expect(get('agent:claude:session').status).toBe('pass');
  expect(JSON.stringify(checks)).not.toContain('raw-detail');
});

test('a drifted binary is reinstalled from the lock, then passes', async () => {
  const pins = parsePins(
    await readFile(resolve(workspace, 'mise.toml'), 'utf8')
  );
  let reinstalled = false;
  const { run, calls } = fake((args) => {
    if (args[0] === 'mise') {
      reinstalled = true;
      return { ok: true, stdout: '' };
    }
    if (args[1] === '--version') {
      const agent = NATIVE_AGENTS.find((a) => a.binary === args[0])!;
      const drifted = agent.name === 'antigravity' && !reinstalled;
      return { ok: true, stdout: drifted ? '9.9.9' : `v ${pins[agent.pin]}` };
    }
    return { ok: true, stdout: args.includes('models') ? 'auto' : 'OK' };
  });
  const checks = await verifyNativeAgents('node-a', workspace, run, {
    cache: NO_CACHE,
  });
  expect(checks.every((check) => check.status === 'pass')).toBe(true);
  expect(
    calls.filter((args) => args[0] === 'mise').map((args) => args.at(-1))
  ).toEqual([`http:antigravity@${pins['http:antigravity']}`]);
});

test('only a browser sign-in authenticate request becomes the API-key method', async () => {
  const { rewriteAuthenticate } = await import('./launch');
  const request = (methodId: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'authenticate',
      params: { methodId },
    });
  expect(JSON.parse(rewriteAuthenticate(request('oauth-personal')))).toEqual({
    jsonrpc: '2.0',
    id: 3,
    method: 'authenticate',
    params: { methodId: 'gemini-api-key' },
  });
  expect(rewriteAuthenticate(request('agent-platform'))).toBe(
    request('agent-platform')
  );
  const prompt = JSON.stringify({
    method: 'session/prompt',
    params: { text: '"authenticate"' },
  });
  expect(rewriteAuthenticate(prompt)).toBe(prompt);
  expect(rewriteAuthenticate('not json "authenticate"')).toBe(
    'not json "authenticate"'
  );
});

test('an account out of quota passes quietly without launching its session', async () => {
  const pins = parsePins(
    await readFile(resolve(workspace, 'mise.toml'), 'utf8')
  );
  const { run, calls } = fake((args) => {
    if (args[1] === '--version') {
      const agent = NATIVE_AGENTS.find((a) => a.binary === args[0])!;
      return { ok: true, stdout: `v ${pins[agent.pin]}` };
    }
    return { ok: true, stdout: args.includes('models') ? 'auto' : 'OK' };
  });
  const checks = await verifyNativeAgents('node-a', workspace, run, {
    outOfQuota: new Set(['codex']),
    cache: NO_CACHE,
  });
  expect(checks.every((check) => check.status === 'pass')).toBe(true);
  expect(calls.some((args) => args[1]?.endsWith('codex-proxy.ts'))).toBe(false);
});

test('a first-launch failure is retried once', async () => {
  const pins = parsePins(
    await readFile(resolve(workspace, 'mise.toml'), 'utf8')
  );
  let grokRuns = 0;
  const { run } = fake((args) => {
    if (args[1] === '--version') {
      const agent = NATIVE_AGENTS.find((a) => a.binary === args[0])!;
      return { ok: true, stdout: `v ${pins[agent.pin]}` };
    }
    if (args[1]?.endsWith('grok-proxy.ts'))
      return { ok: ++grokRuns > 1, stdout: grokRuns > 1 ? 'OK' : '' };
    return { ok: true, stdout: args.includes('models') ? 'auto' : 'OK' };
  });
  const checks = await verifyNativeAgents('node-a', workspace, run, {
    cache: NO_CACHE,
  });
  expect(checks.find((c) => c.id === 'agent:grok:session')?.status).toBe(
    'pass'
  );
  expect(grokRuns).toBe(2);
});
