import { describe, expect, test } from 'bun:test';
import { remoteCommand, shellQuote, sshArgs, sshFailure } from './ssh';
import { runCommand } from './runner';
import { failure, NODE, success } from './test-fixtures';
import { inspectRemote, bundleProbe } from './transport';

describe('safe SSH transport', () => {
  test('enforces verified keys, fresh batch sessions and no agent forwarding', () => {
    const args = sshArgs(NODE);
    for (const option of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      'ClearAllForwardings=yes',
      'ControlPath=none',
      '-a',
      '-T',
    ])
      expect(args).toContain(option);
    expect(args.at(-1)).toBe(NODE.ssh);
    expect(args.join(' ')).not.toContain('StrictHostKeyChecking=no');
  });
  test.skipIf(process.platform === 'win32')(
    'quotes POSIX paths without evaluating shell expressions',
    async () => {
      const value = "/tmp/a'b $(printf evil); test";
      const result = await runCommand([
        'sh',
        '-c',
        `printf '%s' ${shellQuote(value)}`,
      ]);
      expect(result.stdout).toBe(value);
      const command = remoteCommand(
        { ...NODE, workspace: value },
        { action: 'probe' }
      );
      expect(command.at(-1)).toContain(shellQuote(value));
    }
  );
  test.each([
    ['Host key verification failed', 'ssh:host-key'],
    ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'ssh:host-key'],
    ['Could not resolve hostname internal', 'ssh:dns'],
    ['Permission denied (publickey)', 'ssh:auth'],
    ['agent refused operation', 'ssh:auth'],
    ['Connection refused', 'ssh:network'],
    ['bun: command not found', 'ssh:runtime'],
  ])('classifies failures without retaining logs: %s', (message, id) => {
    const check = sshFailure(failure(`${message}\nTOKEN=never-print-this`));
    expect(check.id).toBe(id);
    expect(JSON.stringify(check)).not.toContain('never-print-this');
  });
  test('classifies deadline and missing client separately', () => {
    expect(sshFailure({ ...failure(), reason: 'timeout' }).id).toBe(
      'ssh:timeout'
    );
    expect(sshFailure({ ...failure(), reason: 'missing' }).id).toBe(
      'ssh:missing'
    );
  });
  test('does not treat banners, arbitrary JSON or protocol mismatch as health', async () => {
    for (const stdout of [
      'banner\n{}',
      '{}',
      '{"version":2}',
      'secret-token',
    ]) {
      const report = await inspectRemote(
        NODE,
        { source: '', action: 'probe', timeoutMs: 1000 },
        async () => success(stdout)
      );
      expect(report.checks[0]?.id).toBe('ssh:protocol');
      expect(JSON.stringify(report)).not.toContain('secret-token');
    }
  });
  test('bundles the current probe independently of the remote checkout', async () => {
    const source = await bundleProbe();
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toContain('@pkgs/');
    expect(source).not.toMatch(/from["']\.\.?\//);
  });
});
test('Tailscale check-mode holds are named auth-policy failures even after deadline, with no challenge URL leaked', () => {
  const check = sshFailure({
    ok: false,
    reason: 'timeout',
    stdout: '',
    stderr:
      'Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/PRIVATE_SENTINEL',
  });
  expect(check.id).toBe('ssh:tailscale-check');
  expect(JSON.stringify(check)).not.toContain('PRIVATE_SENTINEL');
});
