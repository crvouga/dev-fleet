import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRemoteAgent } from './remote';
import { runCommand } from '../runner';

test('remote monitoring reports a real competing flock without starting mise', async () => {
  if (process.platform !== 'linux') return;
  const home = await mkdtemp(join(tmpdir(), 'fleet-monitoring-lock-'));
  const revision = 'a'.repeat(40);
  const root = join(home, '.local/share/personal/fleet');
  await mkdir(join(root, 'revisions', revision), { recursive: true });
  try {
    const checks = await installRemoteAgent(
      { id: 'fixture', ssh: 'fixture', workspace: '/unused', required: [] },
      revision,
      {
        systemId: 'abcdefghijklmno',
        hubUrl: 'https://fixture.example.ts.net:8443',
        publicKey: 'ssh-ed25519 fixture',
        token: 'disposable-fixture-token',
      },
      (args, options) =>
        runCommand(
          [
            'flock',
            join(root, 'remote-operation.lock'),
            'sh',
            '-c',
            args.at(-1)!,
          ],
          { ...options, env: { HOME: home } }
        )
    );
    expect(checks[0]?.id).toBe('beszel:lock');
    expect(checks[0]?.summary).toBe('FLEET_REMOTE_LOCKED');
    expect(checks[0]?.status).toBe('fail');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('remote monitoring sends only agent enrollment and redacts invalid evidence', async () => {
  const revision = 'b'.repeat(40);
  const node = {
    id: 'worker-one',
    ssh: 'worker-one',
    workspace: '/unused',
    required: [],
  };
  const enrollment = {
    systemId: 'abcdefghijklmno',
    hubUrl: 'https://manager.example.ts.net:8443',
    publicKey: 'ssh-ed25519 fixture',
    token: 'never-output-token',
  };
  const inputs: string[] = [];
  const pass = await installRemoteAgent(
    node,
    revision,
    enrollment,
    async (_args, options) => {
      inputs.push(options?.input ?? '');
      return {
        ok: true,
        reason: 'exit',
        stderr: '',
        stdout: JSON.stringify({
          version: 1,
          checks: [{ id: 'beszel:service', status: 'pass', summary: 'ok' }],
        }),
      };
    }
  );
  expect(pass.map((check) => check.id)).toEqual(['beszel:service']);
  expect(JSON.parse(inputs[0]!)).toEqual({
    ...enrollment,
    node: node.id,
    revision,
  });
  expect(inputs[0]).not.toContain('"mode"');
  const invalid = await installRemoteAgent(
    node,
    revision,
    enrollment,
    async () => ({
      ok: true,
      reason: 'exit',
      stderr: '',
      stdout: 'raw never-output-token',
    })
  );
  expect(invalid[0]?.summary).toBe('BESZEL_REMOTE_EVIDENCE_INVALID');
  expect(JSON.stringify(invalid)).not.toContain('never-output');
});
