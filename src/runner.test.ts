import { expect, test } from 'bun:test';
import { runCommand } from './runner';

test('captures success and distinguishes missing commands', async () => {
  expect(
    (await runCommand([process.execPath, '-e', 'process.stdout.write("ok")']))
      .stdout
  ).toBe('ok');
  expect((await runCommand(['/fleet-definitely-missing-command'])).reason).toBe(
    'missing'
  );
});

test('bounds output and deadlines', async () => {
  const timeout = await runCommand(
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 100 }
  );
  expect(timeout.ok).toBe(false);
  expect(timeout.reason).toBe('timeout');
  const overflow = await runCommand([
    process.execPath,
    '-e',
    'process.stdout.write("x".repeat(2 * 1024 * 1024))',
  ]);
  expect(overflow.ok).toBe(false);
  expect(overflow.reason).toBe('overflow');
  expect(overflow.stdout.length).toBeLessThanOrEqual(1024 * 1024);
});

test.skipIf(process.platform !== 'linux')(
  'a detached installer retains the remote flock after its JS parent is killed',
  async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const directory = await mkdtemp(join(tmpdir(), 'fleet-inherited-lock-'));
    const lock = join(directory, 'operation.lock');
    const pidFile = join(directory, 'installer.pid');
    const script = `import { runLockedCommand } from ${JSON.stringify(join(import.meta.dirname, 'runner.ts'))}; await runLockedCommand(['sh', '-c', 'echo $$ > "$1"; sleep 2', 'fixture', ${JSON.stringify(pidFile)}]);`;
    const parent = spawn(
      'bash',
      [
        '-c',
        'exec 9>"$1"; flock -n 9 || exit 1; exec "$2" -e "$3"',
        'fixture',
        lock,
        process.execPath,
        script,
      ],
      { stdio: 'ignore' }
    );
    let childPid = 0;
    try {
      for (let attempt = 0; attempt < 30 && !childPid; attempt++) {
        childPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(childPid).toBeGreaterThan(0);
      parent.kill('SIGKILL');
      await new Promise<void>((resolve) =>
        parent.once('close', () => resolve())
      );
      expect((await runCommand(['flock', '-n', lock, 'true'])).ok).toBe(false);
      let released = false;
      for (let attempt = 0; attempt < 30 && !released; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        released = (await runCommand(['flock', '-n', lock, 'true'])).ok;
      }
      expect(released).toBe(true);
    } finally {
      parent.kill('SIGKILL');
      if (childPid) {
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000
);
