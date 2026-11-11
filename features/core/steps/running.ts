import { expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { remoteLockPrelude } from '../../../src/remote-lock';
import { runCommand } from '../../../src/runner';
import type { CommandResult } from '../../../src/types';
import { core, need, root, type CoreWorld } from './world';

/** Commands that really run: the runner is what is described here, so these
 * steps start small programs of their own (this runtime, `sh`, `flock`) and
 * nothing that reaches beyond this process's temporary files.
 */
const { Given, When, Then } = core;

const result = (world: CoreWorld): CommandResult =>
  need(world, world.result, 'a command that was run');

When('this script is run:', async (world, script: string) => {
  world.result = await runCommand([process.execPath, '-e', script]);
});

When(
  'this script is run with a deadline of {int} milliseconds:',
  async (world, timeoutMs: number, script: string) => {
    world.result = await runCommand([process.execPath, '-e', script], {
      timeoutMs,
    });
  }
);

When('the command {string} is run', async (world, command: string) => {
  world.result = await runCommand([command]);
});

Then('it prints exactly {string}', (world, output: string) => {
  expect(result(world).stdout).toBe(output);
});

Then('it did not succeed', (world) => {
  expect(result(world).ok).toBe(false);
});

Then('it ended for the reason {string}', (world, reason: string) => {
  expect<string>(result(world).reason).toBe(reason);
});

Then(
  'at most {int} characters of what it printed are kept',
  (world, length: number) => {
    expect(result(world).stdout.length).toBeLessThanOrEqual(length);
  }
);

// ── The operation lock ───────────────────────────────────────────────────

When('the lock prelude of a remote operation is written', (world) => {
  world.text = remoteLockPrelude();
});

Then('a POSIX shell parses it', (world) => {
  const prelude = need(world, world.text, 'a prelude');
  expect(spawnSync('sh', ['-n', '-c', prelude]).status).toBe(0);
});

Then('a POSIX shell parses the script {string}', (_world, script: string) => {
  const parsed = spawnSync('sh', ['-n', resolve(root, script)], {
    encoding: 'utf8',
  });
  expect(parsed.status, `${script}: ${parsed.stderr}`).toBe(0);
});

const lock = (world: CoreWorld) => need(world, world.lock, 'a lock');
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

Given(
  'a shell that holds the operation lock and starts an installer that runs for {int} seconds with the lock kept',
  async (world, seconds: number) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-inherited-lock-'));
    world.defer(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'operation.lock');
    const pidFile = join(directory, 'installer.pid');
    // The installer writes its process id, then outlives the shell.
    const script = `import { runLockedCommand } from ${JSON.stringify(resolve(root, 'src/runner.ts'))}; await runLockedCommand(['sh', '-c', 'echo $$ > "$1"; sleep ${seconds}', 'fixture', ${JSON.stringify(pidFile)}]);`;
    const shell = spawn(
      'bash',
      [
        '-c',
        'exec 9>"$1"; flock -n 9 || exit 1; exec "$2" -e "$3"',
        'fixture',
        path,
        process.execPath,
        script,
      ],
      { stdio: 'ignore' }
    );
    const held = { path, shell, installer: 0 };
    world.lock = held;
    world.defer(() => {
      shell.kill('SIGKILL');
      if (!held.installer) return;
      try {
        process.kill(-held.installer, 'SIGKILL');
      } catch {}
    });
    for (let attempt = 0; attempt < 30 && !held.installer; attempt++) {
      held.installer = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      if (!held.installer) await pause(100);
    }
  }
);

When('the shell is killed while the installer runs', async (world) => {
  const { shell } = lock(world);
  const closed = new Promise<void>((done) => shell.once('close', () => done()));
  const gone = shell.exitCode !== null || shell.signalCode !== null;
  shell.kill('SIGKILL');
  if (!gone) await closed;
});

Then('the installer had been started', (world) => {
  expect(lock(world).installer).toBeGreaterThan(0);
});

const taken = async (world: CoreWorld): Promise<boolean> =>
  (await runCommand(['flock', '-n', lock(world).path, 'true'])).ok;

Then('the operation lock cannot be taken', async (world) => {
  expect(await taken(world)).toBe(false);
});

Then(
  'the operation lock can be taken once the installer has ended',
  async (world) => {
    let released = false;
    for (let attempt = 0; attempt < 30 && !released; attempt++) {
      await pause(100);
      released = await taken(world);
    }
    expect(released).toBe(true);
  }
);
