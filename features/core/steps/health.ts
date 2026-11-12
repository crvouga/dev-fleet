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
