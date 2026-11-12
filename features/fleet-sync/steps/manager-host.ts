import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import policy from '../../../ansible/macos/policy.json';
import {
  managerBootRecovery,
  managerIdentity,
  managerPower,
} from '../../../src/cli/fleet-sync-manager';
import {
  LINUX_MANAGER,
  MACOS_MANAGER,
  type ManagerHost,
} from '../../../src/platform/manager-host';
import { succeeded } from '../../support/commands';
import {
  ROOT,
  fleetSync,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

const HOST = '(macOS|Linux)';
const hostOf = (name: string): ManagerHost =>
  name === 'Linux' ? LINUX_MANAGER : MACOS_MANAGER;

const phrase = (...parts: string[]): RegExp =>
  new RegExp(`^${parts.join('')}$`);

/** The manager's home directory, for the files a host reads. */
const homes = new WeakMap<FleetSyncWorld, string>();
function home(world: FleetSyncWorld): string {
  let found = homes.get(world);
  if (!found) {
    found = temporary(world, 'manager-home-');
    homes.set(world, found);
  }
  return found;
}

Then(
  phrase('the ', HOST, ' manager supervises its services with "([^"]+)"'),
  (_world, host: string, services: string) => {
    expect(hostOf(host).serviceManager).toBe(services as never);
  }
);
Then(
  phrase('the ', HOST, ' manager hosts its services in "([^"]+)"'),
  (_world, host: string, engine: string) => {
    expect(hostOf(host).containerEngine).toBe(engine as never);
  }
);
Then(
  phrase(
    'the ',
    HOST,
    ` manager keeps its services' data under "([^"]+)" in the home directory`
  ),
  (_world, host: string, data: string) => {
    expect(hostOf(host).dataDirectory('/home/dev')).toBe(
      join('/home/dev', data)
    );
  }
);

// ── Identity ─────────────────────────────────────────────────────────────

Given(
  phrase('the ', HOST, ` manager's local host name is "([^"]+)"`),
  (world, host: string, name: string) => {
    world.commands.answer(
      host === 'Linux' ? 'hostnamectl --static' : 'scutil --get LocalHostName',
      succeeded(`${name}\n`)
    );
  }
);
When(
  phrase(
    'the identity of the ',
    HOST,
    ' manager is measured against "([^"]+)"'
  ),
  async (world, host: string, id: string) => {
    world.checks = [
      await managerIdentity(id, world.commands.run, hostOf(host)),
    ];
  }
);

// ── Power ────────────────────────────────────────────────────────────────

const SLEEP_TARGETS = [
  'sleep.target',
  'suspend.target',
  'hibernate.target',
  'hybrid-sleep.target',
];

function pmsetAc(world: FleetSyncWorld, settings: Record<string, string>) {
  world.commands.answer(
    'pmset -g custom',
    succeeded(
      [
        'AC Power:',
        ...Object.entries(settings).map(
          ([key, value]) => ` ${key.padEnd(20)} ${value}`
        ),
      ].join('\n')
    )
  );
}

function meetPower(world: FleetSyncWorld, host: string, except?: string) {
  if (host === 'Linux')
    for (const target of SLEEP_TARGETS)
      world.commands.answer(
        `systemctl is-enabled ${target}`,
        succeeded(target === except ? 'static\n' : 'masked\n')
      );
  else
    pmsetAc(world, {
      ...policy.pmset,
      ...(except ? { [except]: '0' } : {}),
    });
}

Given(
  phrase(
    'the ',
    HOST,
    ' manager meets its power policy(?:, except "([^"]+)")?'
  ),
  (world, host: string, except?: string) => meetPower(world, host, except)
);
When(
  phrase('the power policy of the ', HOST, ' manager is measured'),
  async (world, host: string) => {
    world.checks = [await managerPower(world.commands.run, '.', hostOf(host))];
  }
);

// ── Boot recovery ────────────────────────────────────────────────────────

function recoverable(world: FleetSyncWorld, host: string, except?: string) {
  if (host === 'Linux') {
    world.commands.answer(
      'loginctl show-user',
      succeeded(except === 'linger' ? 'Linger=no\n' : 'Linger=yes\n')
    );
    world.commands.answer(
      'systemctl is-enabled docker.service',
      succeeded(except === 'docker-autostart' ? 'disabled\n' : 'enabled\n')
    );
    return;
  }
  pmsetAc(world, {
    ...policy.pmset,
    ...(except === 'autorestart' ? { autorestart: '0' } : {}),
  });
  const settings = join(home(world), policy.dockerDesktop.settings);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(
    settings,
    JSON.stringify({
      [policy.dockerDesktop.key]: except !== 'docker-autostart',
      OtherSetting: 1,
    })
  );
  world.commands.answer('fdesetup status', succeeded('FileVault is Off.\n'));
  world.commands.answer(
    'autoLoginUser',
    except === 'login'
      ? { ok: false, stdout: '', stderr: '', reason: 'exit' }
      : succeeded('dev\n')
  );
  world.commands.answer(
    `launchctl print`,
    except === 'launch-agents'
      ? { ok: false, stdout: '', stderr: '', reason: 'exit' }
      : succeeded('state = running\n')
  );
}

Given(
  phrase(
    'the ',
    HOST,
    ' manager has everything that brings it back after a power cut(?:, except "([^"]+)")?'
  ),
  (world, host: string, except?: string) => recoverable(world, host, except)
);
Given('FileVault is on on the macOS manager', (world) => {
  world.commands.answer('fdesetup status', succeeded('FileVault is On.\n'));
});
When(
  phrase('the boot recovery of the ', HOST, ' manager is measured'),
  async (world, host: string) => {
    world.checks = [
      await managerBootRecovery(
        world.commands.run,
        '.',
        hostOf(host),
        home(world)
      ),
    ];
  }
);

Then(
  `the manager's policy declares {string} as {string}`,
  (_world, setting: string, value: string) => {
    expect((policy.pmset as Record<string, string>)[setting]).toBe(value);
  }
);
Then(
  "the manager's playbook turns on the Docker Desktop setting the policy names",
  () => {
    const playbook = readFileSync(
      join(ROOT, 'ansible/macos/manager.yml'),
      'utf8'
    );
    expect(playbook).toContain('dockerDesktop.settings');
    expect(playbook).toContain('combine({dockerDesktop.key: true})');
  }
);
