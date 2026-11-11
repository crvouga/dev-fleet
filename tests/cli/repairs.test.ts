import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeFleet } from '../../src/cli/fleet';
import { addNode } from '../../src/cli/roster';
import { repairScript, targetCommand } from '../../src/cli/repair-script';
import { repairPlan } from '../../src/repair-plan';
import { probe } from '../../src/probe';
import { runCommand } from '../../src/runner';
import {
  failure,
  gitRunner,
  NODE,
  success,
  workspace,
} from '../../src/test-fixtures';
import type { Runner } from '../../src/types';
import type { FleetServices } from '../../src/cli/fleet';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function settings() {
  const root = await workspace();
  roots.push(root);
  return { workspace: root, config: join(root, 'fleet.json') };
}
const noSource = async () => {
  throw new Error('must not bundle');
};

test('repair catalog works without a roster or any command execution', async () => {
  const result = await executeFleet('repairs', {}, await settings(), {
    run: async () => {
      throw new Error('must not run');
    },
    source: noSource,
  });
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({
    command: 'repairs',
    ok: true,
    recipes: expect.any(Array),
    credentials: expect.any(Array),
  });
});

test('repair preview and script are read-only, cover login failures and discard raw credential output', async () => {
  const calls: string[][] = [];
  const base = await settings();
  const result = await executeFleet(
    'repair',
    { local: true, script: true },
    base,
    {
      run: async (command) => {
        calls.push(command);
        return command[0] === 'git'
          ? gitRunner(command)
          : failure('private-secret');
      },
      source: noSource,
    }
  );
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({
    applied: false,
    healthOk: false,
    planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(calls.flat()).not.toContain('personal:install');
  expect(calls.flat()).not.toContain('bootstrap/setup.ts');
  expect(
    calls.some(
      (command) =>
        command[0] === 'gh' && command[1] === 'auth' && command[2] === 'login'
    )
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private-secret');
  const data = result.data as {
    steps: { id: string; automatic: boolean }[];
    script: string;
  };
  expect(data.steps.find((step) => step.id === 'login:codex')?.automatic).toBe(
    false
  );
  expect(data.script).toContain('# cd --');
  expect(data.script).not.toContain('auth.json');
  expect((await runCommand(['sh', '-n'], { input: data.script })).ok).toBe(
    true
  );
});

test('mutations require both flags and refuse stale plans, unsupported repairs and script/apply combinations', async () => {
  const calls: string[][] = [];
  const services: FleetServices = {
    run: async (command) => {
      calls.push(command);
      return gitRunner(command);
    },
    source: noSource,
  };
  const base = await settings();
  for (const options of [
    { local: true, apply: true },
    { local: true, repair: 'login:codex', apply: true, yes: true },
    { local: true, repair: 'arbitrary-secret-command' },
    { local: true, require: 'invalid-capability' },
    { local: true, script: true, apply: true, yes: true },
  ])
    await expect(
      executeFleet('repair', options, base, services)
    ).rejects.toThrow();
  expect(calls).toHaveLength(0);
  await expect(
    executeFleet(
      'repair',
      { local: true, apply: true, yes: true, planHash: 'a'.repeat(64) },
      base,
      services
    )
  ).rejects.toThrow('plan changed');
  expect(calls.flat()).not.toContain('personal:install');
  expect(calls.flat()).not.toContain('bootstrap/setup.ts');
});

test('owner command success is followed by fresh authentication checks and cannot certify an unhealthy machine', async () => {
  let loginsChecked = 0;
  let providerRepairs = 0;
  const base = await settings();
  const result = await executeFleet(
    'repair',
    {
      local: true,
      require: 'codex,workstation',
      repair: 'providers',
      apply: true,
      yes: true,
    },
    base,
    {
      run: async (command) => {
        if (command[0] === 'codex') loginsChecked += 1;
        if (command.includes('bootstrap/worker-auth.ts')) {
          providerRepairs += 1;
          return success('{"ok":true,"private":"private-secret"}');
        }
        return gitRunner(command);
      },
      source: noSource,
    }
  );
  expect(providerRepairs).toBe(1);
  expect(loginsChecked).toBe(2);
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({
    applied: true,
    executionOk: true,
    healthOk: false,
    ok: false,
    completed: 1,
  });
  expect(JSON.stringify(result)).not.toContain('private-secret');
});

test('failed setup stops workstation repair and still returns fresh remaining checks', async () => {
  const calls: string[][] = [];
  const result = await executeFleet(
    'repair',
    { local: true, apply: true, yes: true },
    await settings(),
    {
      run: async (command) => {
        calls.push(command);
        return command[0] === 'mise'
          ? failure('private-secret')
          : gitRunner(command);
      },
      source: noSource,
    }
  );
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({
    executionOk: false,
    remaining: expect.any(Array),
  });
  expect(calls.flat()).not.toContain('personal:install');
  expect(JSON.stringify(result)).not.toContain('private-secret');
});

test('selected remote repairs stream only fixed actions over verified SSH, carry expected inputs, and re-probe afterward', async () => {
  const base = await settings();
  await addNode(base.config, NODE, true);
  const snapshot = await probe(base.workspace, [], gitRunner);
  let repairs = 0;
  let probes = 0;
  const run: Runner = async (command, options) => {
    expect(command[0]).toBe('ssh');
    expect(command).toContain('StrictHostKeyChecking=yes');
    expect(command).toContain('-a');
    expect(options?.input).toBe('fixture-probe');
    const encoded = /'([^']+)'$/.exec(command.at(-1)!)![1]!;
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (request.action === 'repair') {
      repairs += 1;
      expect(request).toMatchObject({
        apply: true,
        repairs: ['providers'],
        expected: snapshot.fingerprint,
        node: { workspace: NODE.workspace },
      });
      return success(
        '{"version":1,"checks":[{"id":"repair:providers","status":"pass","summary":"owner completed"}]}'
      );
    }
    probes += 1;
    return success(JSON.stringify(snapshot));
  };
  const result = await executeFleet(
    'repair',
    { node: [NODE.id], repair: 'providers', apply: true, yes: true },
    base,
    { run, source: async () => 'fixture-probe' }
  );
  expect(repairs).toBe(1);
  expect(probes).toBe(2);
  expect(result.data).toMatchObject({
    executionOk: true,
    applied: true,
    coverage: { scope: 'selected' },
  });
});

test('generated command quoting preserves literal paths and arguments; native login instructions remain comments', async () => {
  const base = await settings();
  const literal = "$(touch should-not-exist); ' private";
  const result = await runCommand([
    'sh',
    '-c',
    targetCommand({ name: 'local', root: base.workspace }, [
      ['printf', '%s', literal],
    ]),
  ]);
  expect(result.stdout).toBe(literal);
  const snapshot = await probe(base.workspace, [], gitRunner);
  const steps = repairPlan(
    [
      {
        node: 'local',
        snapshot,
        checks: [{ id: 'auth:codex', status: 'fail', summary: 'Sign in' }],
      },
    ],
    [{ name: 'local', root: base.workspace }]
  );
  const script = repairScript(steps, [{ name: 'local', root: base.workspace }]);
  expect(
    script
      .split('\n')
      .filter((line) => line.includes("'codex'"))
      .every((line) => line.startsWith('# '))
  ).toBe(true);
  expect((await runCommand(['sh', '-n'], { input: script })).ok).toBe(true);
});

test('whole-tailnet preview retains offline unregistered computers as blocked operator work', async () => {
  const base = await settings();
  const inventory = JSON.stringify({
    BackendState: 'Running',
    Health: null,
    Self: {
      ID: 'self',
      HostName: 'self',
      DNSName: 'self.tailnet.ts.net.',
      OS: 'linux',
      TailscaleIPs: ['100.64.0.1'],
      Online: true,
    },
    Peer: {
      offline: {
        ID: 'offline',
        HostName: 'offline',
        DNSName: 'offline.tailnet.ts.net.',
        OS: 'macOS',
        TailscaleIPs: ['100.64.0.2'],
        Online: false,
      },
    },
  });
  const result = await executeFleet('repair', {}, base, {
    run: async (command) => {
      expect(command[0]).not.toBe('ssh');
      return command[0] === 'tailscale'
        ? success(inventory)
        : gitRunner(command);
    },
    source: noSource,
  });
  expect(result.data).toMatchObject({
    applied: false,
    healthOk: false,
    coverage: { scope: 'tailscale-visible-computers' },
  });
  const steps = (
    result.data as { steps: { node: string; eligible: boolean }[] }
  ).steps.filter((step) => step.node === 'offline.tailnet.ts.net');
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.every((step) => !step.eligible)).toBe(true);
});

test('post-repair configuration failure preserves execution results and never reuses old health as fresh', async () => {
  const base = await settings();
  await addNode(base.config, NODE, true);
  const snapshot = await probe(base.workspace, [], gitRunner);
  const result = await executeFleet(
    'repair',
    { node: [NODE.id], repair: 'providers', apply: true, yes: true },
    base,
    {
      run: async (command) => {
        const encoded = /'([^']+)'$/.exec(command.at(-1)!)![1]!;
        const request = JSON.parse(Buffer.from(encoded, 'base64').toString());
        expect(request.node.workspace).toBe(NODE.workspace);
        if (request.action === 'repair') {
          await writeFile(base.config, '{changed-invalid-roster');
          return success(
            '{"version":1,"checks":[{"id":"repair:providers","status":"pass","summary":"owner completed"}]}'
          );
        }
        return success(JSON.stringify(snapshot));
      },
      source: async () => 'fixture-probe',
    }
  );
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({
    applied: true,
    executionOk: true,
    healthOk: false,
    completed: 1,
    nodes: [{ checks: [{ id: 'repair:recheck', status: 'fail' }] }],
    executions: [{ checks: [{ id: 'repair:providers', status: 'pass' }] }],
  });
});
