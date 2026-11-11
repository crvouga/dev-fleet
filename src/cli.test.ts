import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './runner';
import { bundleProbe, inspectRemote } from './transport';
import { NODE, workspace } from './test-fixtures';

const roots: string[] = [];
const cli = fileURLToPath(new URL('./cli/cli.ts', import.meta.url));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-cli-'));
  roots.push(root);
  return root;
}

test('CLI help/schema work without a roster or credentials', async () => {
  for (const args of [['fleet-nodes', '--schema'], ['fleet-nodes']]) {
    const result = await runCommand(
      [process.execPath, cli, ...args, '--json'],
      { cwd: await directory() }
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toBeObject();
    expect(result.stderr).toBe('');
  }
});

test('node registration previews only, writes exclusively, and never overwrites an entry', async () => {
  const root = await directory();
  const path = join(root, 'roster.json');
  const args = [
    process.execPath,
    cli,
    'fleet-node-add',
    '--id',
    NODE.id,
    '--ssh',
    NODE.ssh,
    '--path',
    NODE.workspace,
    '--config',
    path,
    '--json',
  ];
  const preview = await runCommand(args);
  expect(JSON.parse(preview.stdout).applied).toBe(false);
  expect(await Bun.file(path).exists()).toBe(false);
  expect((await runCommand([...args, '--apply', '--yes'])).ok).toBe(true);
  const contents = await readFile(path, 'utf8');
  expect(JSON.parse(contents).version).toBe(1);
  expect((await runCommand([...args, '--apply', '--yes'])).ok).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(contents);
});

test('repair preview and onboarding never attempt SSH/auth or silently apply', async () => {
  const root = await directory();
  const config = join(root, 'roster.json');
  await runCommand([
    process.execPath,
    cli,
    'fleet-node-add',
    '--id',
    NODE.id,
    '--ssh',
    NODE.ssh,
    '--path',
    NODE.workspace,
    '--config',
    config,
    '--apply',
    '--yes',
  ]);
  const preview = await runCommand([
    process.execPath,
    cli,
    'fleet-repair',
    '--list',
    '--config',
    config,
    '--yes',
    '--json',
  ]);
  expect(preview.ok).toBe(true);
  expect(JSON.parse(preview.stdout).ok).toBe(true);
  const onboard = await runCommand([
    process.execPath,
    cli,
    'fleet-nodes',
    '--onboard',
    '--config',
    config,
    '--json',
  ]);
  expect(JSON.parse(onboard.stdout).nodes[0].sshTemplate).toContain(
    'IdentitiesOnly yes'
  );
  expect(JSON.parse(onboard.stdout).nodes[0].applied).toBe(false);
});

test('usage errors are JSON and never echo arbitrary option values', async () => {
  const result = await runCommand([
    process.execPath,
    cli,
    'fleet-status',
    '--unrecognized-secret=never-print-this',
  ]);
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.stdout).code).toBe('invalid_usage');
  expect(`${result.stdout}${result.stderr}`).not.toContain('never-print-this');
});

test.skipIf(process.platform === 'win32')(
  'current bundle executes over stdin without a fleet package on the target',
  async () => {
    const root = await workspace();
    roots.push(root);
    const source = await bundleProbe();
    const node = { ...NODE, workspace: root, runtime: process.execPath };
    const report = await inspectRemote(
      node,
      { source, timeoutMs: 5000, action: 'probe' },
      async (command, options) =>
        runCommand(['sh', '-c', command.at(-1)!], options)
    );
    expect(report.checks[0]?.id).toBe('ssh:session');
    expect(report.snapshot?.version).toBe(1);
    expect(report.snapshot?.fingerprint.files['workspace-manifests']).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(
      report.checks.some(
        (check) => check.id === 'vscode:forwarding' && check.status === 'skip'
      )
    ).toBe(true);
  }
);
