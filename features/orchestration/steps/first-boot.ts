import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { diagnostic } from '../../../src/diagnostics';
import { orchestration, type OrchestrationWorld } from '../support/world';

/** The first-boot step of the remote bootstrap, cut from the script between
 * its markers and run in a real shell with a stand-in for cloud-init.
 */
const { Given, When, Then } = orchestration;

const SCRIPT = resolve(
  import.meta.dir,
  '../../../bootstrap/fleet-remote-bootstrap.sh'
);

function step(): string {
  const text = readFileSync(SCRIPT, 'utf8');
  const begin = text.indexOf('# first-boot: begin');
  const end = text.indexOf('# first-boot: end');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end);
}

interface FirstBoot {
  bin: string;
  stdout?: string;
  elapsedMs?: number;
}
const boots = new WeakMap<OrchestrationWorld, FirstBoot>();

function firstBoot(world: OrchestrationWorld): FirstBoot {
  let found = boots.get(world);
  if (!found) {
    const bin = mkdtempSync(join(tmpdir(), 'devfleet-first-boot-'));
    world.defer(() => rmSync(bin, { recursive: true, force: true }));
    // Every Ubuntu worker has GNU timeout; older macOS runners have none, so
    // there a stand-in with its exit code 124 takes its place.
    if (!['/usr/bin/timeout', '/bin/timeout'].some(existsSync)) {
      writeFileSync(
        join(bin, 'timeout'),
        [
          '#!/bin/sh',
          'limit=$1; shift',
          '"$@" & child=$!',
          '( sleep "$limit"; kill "$child" 2>/dev/null; : >"$0.expired" ) >/dev/null 2>&1 & timer=$!',
          'wait "$child"; code=$?',
          'kill "$timer" 2>/dev/null',
          'if [ -e "$0.expired" ]; then rm -f "$0.expired"; exit 124; fi',
          'exit "$code"',
          '',
        ].join('\n')
      );
      chmodSync(join(bin, 'timeout'), 0o755);
    }
    found = { bin };
    boots.set(world, found);
  }
  return found;
}

function cloudInit(world: OrchestrationWorld, body: string): void {
  const path = join(firstBoot(world).bin, 'cloud-init');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$*" >>"${firstBoot(world).bin}/asked"\n${body}\n`
  );
  chmodSync(path, 0o755);
}

Given(
  'cloud-init reports its first boot finished with the exit code {int}',
  (world, code: number) => {
    cloudInit(world, `exit ${code}`);
  }
);

Given('cloud-init never finishes the first boot', (world) => {
  cloudInit(world, 'exec sleep 60');
});

Given('the machine has no cloud-init', (world) => {
  firstBoot(world);
});

When(
  'the first-boot step runs with a bound of {int} seconds',
  (world, seconds: number) => {
    const boot = firstBoot(world);
    const program = [
      `first_boot_wait=${seconds}`,
      'die() { echo "$1"; exit 1; }',
      'operation() { :; }',
      step(),
      'echo WENT_ON',
    ].join('\n');
    const started = Date.now();
    // Only the stand-in and the system's own tools: no cloud-init of the
    // machine running the scenario is ever found.
    const result = spawnSync('/bin/sh', ['-c', program], {
      env: { PATH: `${boot.bin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    boot.elapsedMs = Date.now() - started;
    boot.stdout = result.stdout.trim();
  }
);

Then('the bootstrap goes on', (world) => {
  expect(firstBoot(world).stdout).toBe('WENT_ON');
});

Then('the bootstrap stops with {string}', (world, code: string) => {
  expect(firstBoot(world).stdout).toBe(code);
});

Then('it stopped within {int} seconds', (world, seconds: number) => {
  expect(firstBoot(world).elapsedMs).toBeLessThan(seconds * 1000);
});

Then('cloud-init was asked to wait for the first boot', (world) => {
  const asked = join(firstBoot(world).bin, 'asked');
  expect(existsSync(asked)).toBe(true);
  expect(readFileSync(asked, 'utf8').trim()).toBe('status --wait');
});

Then(
  /^the diagnostic of "([A-Z_]+)" is (retryable|not retryable)$/,
  (_world, code: string, verdict: string) => {
    const found = diagnostic('worker-one', {
      id: 'bootstrap:first-boot',
      status: 'fail',
      summary: code,
    });
    expect(found.retryable).toBe(verdict === 'retryable');
  }
);
