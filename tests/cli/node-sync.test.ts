import { expect, test } from 'bun:test';
import { syncNode } from '../../src/cli/node-sync';
import { execute } from '../../src/cli/program';
import type { Runner } from '../../src/types';

const settings = {
  workspace: '/not-a-real-checkout',
  config: '/not-a-real-roster',
};
const revision = 'a'.repeat(40);
const roster = async () => [
  {
    tool: 'codex',
    email: 'a@example.com',
    prefix: 'codex-a@example.com',
    models: ['gpt-x'],
  },
];

test('dry run resolves a revision but never invokes a mutation', async () => {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    return { ok: true, stdout: revision, stderr: '', reason: 'exit' };
  };
  const result = await syncNode(
    { id: 'dev-linux', dryRun: true },
    settings,
    run
  );
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({
    applied: false,
    revision,
    node: 'dev-linux',
    profile: 'proxy',
  });
  expect(calls).toEqual([['git', 'rev-parse', '--verify', 'HEAD']]);
});

test('invalid node names fail before running tools', async () => {
  let called = false;
  const run: Runner = async () => {
    called = true;
    throw new Error('unexpected');
  };
  await expect(syncNode({ id: '../bad' }, settings, run)).rejects.toThrow();
  expect(called).toBe(false);
});

test('flat commands are discoverable and document default apply', async () => {
  const help = await execute(['fleet-node-sync', '--help'], settings, 'test');
  expect(help.exitCode).toBe(0);
  expect(help.text).toContain('--dry-run');
  const catalog = await execute(['commands', '--json'], settings, 'test');
  expect(JSON.stringify(catalog.data)).toContain('fleet-node-sync');
});

test('node sync joins profile/launcher/T3 reconciliation and is repeatable', async () => {
  if (process.platform === 'win32') return;
  const fixture = await syncFixture();
  try {
    const result = await syncNode(
      { id: 'node', t3Home: fixture.t3Home, roster },
      fixture.settings,
      fixture.run
    );
    expect(result.exitCode).toBe(0);
    const t3 = await Bun.file(
      fixture.t3Home + '/userdata/settings.json'
    ).json();
    expect(
      t3.providerInstances.personal_codex_a_example_com.config.binaryPath
    ).toContain(fixture.directory);
    expect(
      (
        await Bun.file(
          fixture.settings.workspace + '/node_modules/.personal-node.json'
        ).json()
      ).revision
    ).toBe(revision);
    expect(
      (
        await syncNode(
          { id: 'node', t3Home: fixture.t3Home, roster },
          fixture.settings,
          fixture.run
        )
      ).exitCode
    ).toBe(0);
  } finally {
    await fixture.clean();
  }
});

test('node sync reports partial progress and does not advance receipt on T3 conflict', async () => {
  if (process.platform === 'win32') return;
  const fixture = await syncFixture();
  const { mkdir, writeFile } = await import('node:fs/promises');
  try {
    await mkdir(fixture.t3Home + '/userdata', { recursive: true });
    await writeFile(
      fixture.t3Home + '/userdata/settings.json',
      JSON.stringify({
        providerInstances: { personal_grok_proxy: { driver: 'grok' } },
      })
    );
    const result = await syncNode(
      { id: 'node', t3Home: fixture.t3Home, roster },
      fixture.settings,
      fixture.run
    );
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({ applied: true, stage: 't3' });
    expect(
      await Bun.file(
        fixture.settings.workspace + '/node_modules/.personal-node.json'
      ).exists()
    ).toBe(false);
  } finally {
    await fixture.clean();
  }
});

async function syncFixture() {
  const { mkdtemp, mkdir, copyFile, rm, realpath } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'personal-node-')));
  const directory = join(root, 'node_modules/.fleet-revisions', revision);
  await mkdir(join(directory, 'agents'), {
    recursive: true,
  });
  await copyFile(
    new URL('../../agents/t3.json', import.meta.url),
    join(directory, 'agents/t3.json')
  );
  const run: Runner = async (args) => {
    const stdout = args.includes('--show-toplevel')
      ? directory
      : args[1] === 'rev-parse'
        ? revision
        : args.includes('apply')
          ? JSON.stringify({ ok: true, revision, fingerprint: 'b'.repeat(64) })
          : '';
    return { ok: true, stdout, stderr: '', reason: 'exit' };
  };
  return {
    settings: { workspace: root, config: join(root, 'roster.json') },
    directory,
    t3Home: join(root, 't3'),
    run,
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
