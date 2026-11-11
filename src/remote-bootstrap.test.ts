import { expect, test } from 'bun:test';
import { bootstrapRemote } from './remote-bootstrap';
import type { FleetNode } from './types';
const node: FleetNode = {
  id: 'devbox',
  ssh: 'devbox',
  workspace: '/unused',
  required: [],
};
const payload = {
  revision: 'a'.repeat(40),
  digest: 'b'.repeat(64),
  bundle: 'ZmFrZS1idW5kbGU=',
  script: '#!/bin/sh\n# fixture',
};
const success = {
  version: 1,
  checks: [
    {
      id: 'fixture:configuration',
      status: 'pass',
      summary: 'Verified fixture',
    },
  ],
};
const result = (stdout: string, ok = true) => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});
test('a verified cached source avoids resending the repository history', async () => {
  let invocation = 0;
  await bootstrapRemote(node, payload, async (args, options) => {
    invocation++;
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('-a');
    if (invocation === 1) return result('ready');
    expect(options?.input).toBe('');
    expect(args.at(-1)).toContain("'cached'");
    return result(JSON.stringify(success));
  });
  expect(invocation).toBe(2);
});
test('an absent cache transfers the verified bundle and preserves structured failure evidence', async () => {
  let invocation = 0;
  const report = await bootstrapRemote(node, payload, async (args, options) => {
    invocation++;
    if (invocation === 1) return result('', false);
    expect(options?.input).toBe(payload.bundle);
    expect(args.at(-1)).toContain("'transfer'");
    return result(
      JSON.stringify({
        version: 1,
        checks: [
          {
            id: 'bootstrap:prerequisites',
            status: 'fail',
            summary: 'SUDO_AUTHORIZATION_REQUIRED',
            secret: 'PRIVATE_SENTINEL',
          },
        ],
      }),
      false
    );
  });
  expect(report.checks[0]?.summary).toBe('SUDO_AUTHORIZATION_REQUIRED');
  expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
});
test('unknown host keys stop before sending any bootstrap payload', async () => {
  let calls = 0;
  const report = await bootstrapRemote(
    node,
    payload,
    async (_args, options) => {
      calls++;
      expect(options?.input).toBeUndefined();
      return {
        ok: false,
        reason: 'exit',
        stdout: '',
        stderr: 'Host key verification failed. PRIVATE_SENTINEL',
      };
    }
  );
  expect(calls).toBe(1);
  expect(report.checks[0]?.id).toBe('ssh:host-key');
  expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
});
test('partial pass evidence cannot mask a failed remote process', async () => {
  let calls = 0;
  const report = await bootstrapRemote(node, payload, async () => {
    calls++;
    return calls === 1
      ? result('ready')
      : result(JSON.stringify(success), false);
  });
  expect(
    report.checks.some(
      (check) => check.summary === 'REMOTE_BOOTSTRAP_EXIT_FAILED'
    )
  ).toBe(true);
});

test('the bundle carries one commit without history and a shallow checkout accepts it', async () => {
  const { mkdtemp, realpath, rm, writeFile, readFile } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runCommand } = await import('./runner');
  const { prepareBootstrap } = await import('./remote-bootstrap');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fleet-bundle-')));
  const git = (cwd: string, ...args: string[]) =>
    runCommand(
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { cwd }
    );
  try {
    const source = join(dir, 'source');
    await git(dir, 'init', '-q', source);
    await git(
      source,
      'remote',
      'add',
      'origin',
      'https://github.com/crvouga/dev-fleet.git'
    );
    for (const path of [
      'bootstrap/fleet-remote-bootstrap.sh',
      'ansible/ubuntu/authorize-sudo.sh',
    ]) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(source, path, '..'), { recursive: true });
      await writeFile(join(source, path), '#!/bin/sh\n');
    }
    await writeFile(join(source, 'old.txt'), 'history that must not travel');
    await git(source, 'add', '-A');
    await git(source, 'commit', '-qm', 'first');
    await git(source, 'rm', '-q', 'old.txt');
    await writeFile(join(source, 'new.txt'), 'current');
    await git(source, 'add', '-A');
    await git(source, 'commit', '-qm', 'second');
    const revision = (await git(source, 'rev-parse', 'HEAD')).stdout.trim();
    const payload = await prepareBootstrap(dir, revision, runCommand, {
      checkout: source,
    });
    expect(payload?.revision).toBe(revision);
    const bundle = join(dir, 'received.bundle');
    await writeFile(bundle, Buffer.from(payload!.bundle, 'base64'));
    const target = join(dir, 'target');
    await git(dir, 'init', '-q', target);
    // What fleet-remote-bootstrap.sh does on the worker.
    await writeFile(join(target, '.git/shallow'), revision + '\n');
    expect((await git(target, 'fetch', '--no-tags', bundle, revision)).ok).toBe(
      true
    );
    expect((await git(target, 'checkout', '--detach', revision)).ok).toBe(true);
    expect(await readFile(join(target, 'new.txt'), 'utf8')).toBe('current');
    expect((await git(target, 'status', '--porcelain')).stdout).toBe('');
    expect(
      (await git(target, 'rev-list', '--count', 'HEAD')).stdout.trim()
    ).toBe('1');
    expect((await git(target, 'fsck', '--no-dangling')).ok).toBe(true);
    expect(
      (await readFile(bundle)).includes('history that must not travel')
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
