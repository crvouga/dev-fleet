import { expect } from 'bun:test';
import { join } from 'node:path';
import { succeeded } from '../../support/commands';
import { managerHealth } from '../../../src/manager-health';
import { parseTailnet, keyExpiryCheck } from '../../../src/tailscale';
import { workerCapacity } from '../../../src/worker-capacity';
import { rebootPendingCheck } from '../../../src/worker-host-checks';
import type { Check } from '../../../src/types';
import { core, need, root, type CoreWorld } from './world';

/** The health of a machine itself: its disk, its clock, its pending reboot,
 * its Tailscale key and, on the manager, its operating system.
 */
const { When } = core;

function reported(world: CoreWorld, checks: Check[]): void {
  world.checks = checks;
  world.outcome = checks;
}

When('the capacity of the worker is checked', async (world) => {
  reported(world, await workerCapacity(root, 'worker-a', world.commands.run));
});

When(
  /^the capacity of the worker is checked against the manager's clock at (\d+)$/,
  async (world, reference: string) => {
    reported(
      world,
      await workerCapacity(
        root,
        'worker-a',
        world.commands.run,
        Number(reference)
      )
    );
  }
);

When(
  /^the pending reboot of the worker is checked on "([^"]+)"$/,
  async (world, date: string) => {
    reported(world, [
      await rebootPendingCheck(true, world.commands.run, Date.parse(date)),
    ]);
  }
);

When('a worker with no pending reboot is checked', async (world) => {
  reported(world, [await rebootPendingCheck(false, world.commands.run)]);
});

When(
  'the Tailscale key of the computer {string} is checked on {string}',
  (world, id: string, date: string) => {
    const tailnet = parseTailnet(
      need(world, world.tailscale, 'a status of Tailscale')
    );
    reported(world, [
      keyExpiryCheck(
        tailnet.computers.find((computer) => computer.id === id),
        Date.parse(date)
      ),
    ]);
  }
);

When('the health of the manager is checked', async (world) => {
  reported(world, await managerHealth(world.commands.run));
});

core.Then('the check {string} has a remedy', (world, id: string) => {
  const check = world.checks.find((entry) => entry.id === id);
  if (!check?.remedy?.action) throw new Error(`${id} has no remedy.`);
});

// ── The container watchdog ───────────────────────────────────────────────

const watchdog = new WeakMap<
  CoreWorld,
  { memory: Record<string, { capped: number | null }>; restart: string[][] }
>();

/** The watchdog's own decision, from its own module, run once per sample. */
const DECIDE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('watchdog', sys.argv[1])
watchdog = importlib.util.module_from_spec(spec); spec.loader.exec_module(watchdog)
memory = {'proxy': {'unhealthy': 0, 'restarts': [1000.0 - 60 * i for i in range(int(sys.argv[3]))], 'capped': None}}
restart = []
for status in sys.argv[2].split(', '):
    memory, started = watchdog.decide(memory, {'proxy': status}, 1000.0, 3, 3)
    restart += started
print(json.dumps({'memory': memory, 'restart': restart}))`;

core.When(
  /^the watchdog has seen the container "proxy" as (.+), having restarted it (\d+) times in the last hour$/,
  (world, seen: string, restarts: string) => {
    const out = Bun.spawnSync([
      'python3',
      '-I',
      '-B',
      '-c',
      DECIDE,
      join(root, 'ansible/monitoring/container-watchdog.py'),
      seen,
      restarts,
    ]);
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    watchdog.set(world, JSON.parse(out.stdout.toString()));
  }
);

core.Then(
  'the watchdog restarts {string}, {string}',
  (world, name: string, reason: string) => {
    const decided = watchdog.get(world)!;
    expect(decided.restart).toEqual([[name, reason]]);
    expect(decided.memory['proxy']!.capped).toBeNull();
  }
);

core.Then(
  /^the watchdog restarts nothing( and caps "proxy")?$/,
  (world, caps) => {
    const decided = watchdog.get(world)!;
    expect(decided.restart).toEqual([]);
    expect(decided.memory['proxy']!.capped !== null).toBe(Boolean(caps));
  }
);

core.Given(
  'the container watchdog remembers {string}, where NOW is the time now',
  (world, memory: string) => {
    world.commands.answer(
      (argv) => argv[0] === 'cat',
      () => succeeded(memory.replaceAll('NOW', String(Date.now() / 1000)))
    );
  }
);
