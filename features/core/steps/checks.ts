import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { succeeded } from '../../support/commands';
import { powerRecoveryCheck } from '../../../src/power-recovery';
import { convergeProxy } from '../../../src/proxy-converge';
import { codingAuth, serviceAuth } from '../../../src/service-auth';
import { toolchainChecks } from '../../../src/toolchain-checks';
import { workerAccessChecks } from '../../../src/worker-access-checks';
import {
  serviceRecoveryCheck,
  serviceState,
} from '../../../src/worker-host-checks';
import {
  runningVersionCheck,
  t3RestartMarker,
} from '../../../src/platform/t3-service';
import { workstationChecks } from '../../../src/workstation-checks';
import type { Check } from '../../../src/types';
import { core, need, type CoreWorld } from './world';

/** The checks a machine runs on itself: each When runs one of them against
 * the commands the scenario described.
 */
const { Given, When, Then } = core;

function reported(world: CoreWorld, checks: Check[]): void {
  world.checks = checks;
  world.outcome = checks;
}

When(
  /^the "(codex|claude)" sign-in is checked$/,
  async (world, agent: 'codex' | 'claude') => {
    reported(world, await codingAuth(agent, world.commands.run));
  }
);

When('the sign-ins to the services are checked', async (world) => {
  reported(world, await serviceAuth(world.commands.run));
});

Given(
  'the doctor of the checkout reports ok, with these checks:',
  (world, table: DataTable) => {
    world.commands.otherwise = succeeded(
      JSON.stringify({ ok: true, checks: table.hashes() })
    );
  }
);

When(
  'the toolchain of the checkout at {string} is checked',
  async (world, checkout: string) => {
    reported(world, await toolchainChecks(checkout, world.commands.run));
  }
);

When('the access of the worker is checked', async (world) => {
  reported(world, await workerAccessChecks(world.commands.run));
});

When(
  'the recovery of the worker after a power loss is checked',
  async (world) => {
    reported(world, [await powerRecoveryCheck(world.commands.run)]);
  }
);

When("the worker's service recovery is checked", async (world) => {
  reported(world, [await serviceRecoveryCheck(world.commands.run)]);
});

When('the release of the running T3 is checked', async (world) => {
  reported(world, [await runningVersionCheck(world.commands.run, 1000)]);
});

Given(
  'a restart of T3 has been deferred for {int} hours',
  (world, hours: number) => {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    world.commands.answer(
      (command) => command.join(' ') === `cat ${t3RestartMarker(1000)}`,
      succeeded(`${since}\n`)
    );
  }
);

When(
  'the devfleet launcher of the checkout at {string} is checked',
  async (world, checkout: string) => {
    reported(world, await workstationChecks(checkout, world.commands.run));
  }
);

When(
  'the proxy is converged on {string} at the revision {string}',
  async (world, node: string, revision: string) => {
    reported(world, await convergeProxy(node, revision, world.commands.run));
  }
);

When(
  'systemd shows the service {string} as:',
  (world, name: string, properties: string) => {
    // systemctl ends every property it shows, the last too, with a line break.
    world.text = serviceState(name, `${properties}\n`);
  }
);

Then('the service is reported as {string}', (world, text: string) => {
  expect(need(world, world.text, 'a service')).toBe(text);
});

Then(
  'the report of the service starts with {string}',
  (world, text: string) => {
    expect(need(world, world.text, 'a service')).toStartWith(text);
  }
);
