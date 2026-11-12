import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import example from '../../../examples/fleet.json';
import { parseDefinition } from '../../../src/definition';
import {
  evaluateEnvironment,
  evaluateMachineClass,
  evaluatePlatform,
  evaluateSize,
  platformProbe,
} from '../../../src/machine/platform';
import type { DataTable } from '../../support/gherkin';
import {
  detectPlatformName,
  getPlatform,
  type PlatformName,
} from '../../../src/platform';
import {
  WORKER_PLATFORMS,
  workerPlatform,
} from '../../../src/platform/ubuntu-worker';
import { machines, temporary } from './world';

const { Given, When, Then } = machines;

// ── Adapters ─────────────────────────────────────────────────────────────

Then(
  'the operating system {string} is the platform {string}',
  (_world, reported: string, platform: string) => {
    expect(detectPlatformName(reported as NodeJS.Platform)).toBe(
      platform as PlatformName
    );
  }
);

When('the adapter of the platform {string} is asked for', (world, name) => {
  world.adapter = getPlatform(name as PlatformName);
});

Then('the adapter is named {string}', (world, name: string) => {
  expect(world.adapter!.name).toBe(name as PlatformName);
});

Then(
  'it names a directory for OpenCode, a cache directory and a directory for global commands',
  (world) => {
    expect(world.adapter!.opencodeDir().length).toBeGreaterThan(0);
    expect(world.adapter!.cacheDir().length).toBeGreaterThan(0);
    expect(world.adapter!.globalBinDir().length).toBeGreaterThan(0);
  }
);

Then('it says what its notifier can do', (world) => {
  expect(world.adapter!.notifierCapabilities()).toBeDefined();
});

Then('it cannot build the Swift notifier', (world) => {
  expect(world.adapter!.canBuildSwiftNotifier()).toBe(false);
});

Then(
  'it gives the same answer each time it is asked whether it can build the Swift notifier',
  (world) => {
    expect(world.adapter!.canBuildSwiftNotifier()).toBe(
      world.adapter!.canBuildSwiftNotifier()
    );
  }
);

// ── Which machines are converged ─────────────────────────────────────────

When(
  'a worker answers the probe with {string}, {string}, {string} and {string}',
  (
    world,
    family: string,
    release: string,
    cpu: string,
    environment: string
  ) => {
    const probe = `${family}\n${release}\n${cpu}\n${environment}\n`;
    world.baseline = evaluatePlatform(probe);
    world.environment = evaluateEnvironment(probe);
  }
);

Then(
  /^the "([^"]+)" check says the worker is (supported|not supported)$/,
  (world, id: string, verdict: string) => {
    const evaluated = [world.baseline, world.environment].find(
      (entry) => entry?.id === id
    );
    expect(evaluated).toMatchObject({ id, supported: verdict === 'supported' });
  }
);

Then('the baseline is summarised as {string}', (world, summary: string) => {
  expect(world.baseline?.summary).toBe(summary);
});

Then('the environment is summarised as {string}', (world, summary: string) => {
  expect(world.environment?.summary).toBe(summary);
});

Given(
  'a root whose kernel release reads {string} and that holds the files:',
  async (world, kernel: string, table: DataTable) => {
    const root = await temporary(world, 'probe-root-');
    await mkdir(join(root, 'proc/sys/kernel'), { recursive: true });
    await writeFile(join(root, 'proc/sys/kernel/osrelease'), `${kernel}\n`);
    for (const path of table.list().filter(Boolean)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), '');
    }
    // The host's own systemd-detect-virt must not answer for the stand-in.
    await mkdir(join(root, 'bin'));
    await writeFile(
      join(root, 'bin/systemd-detect-virt'),
      '#!/bin/sh\nexit 1\n',
      {
        mode: 0o755,
      }
    );
    world.probeRoot = root;
  }
);

Given(
  'systemd-detect-virt there reports {string}',
  async (world, hypervisor: string) => {
    const root = world.probeRoot!;
    // A hypervisor is not a container; bare metal exits 1, as systemd does.
    await writeFile(
      join(root, 'bin/systemd-detect-virt'),
      `#!/bin/sh\n[ "$1" = --container ] && exit 1\necho ${hypervisor}\n[ ${hypervisor} != none ]\n`,
      { mode: 0o755 }
    );
    world.hypervisor = hypervisor;
  }
);

Given(
  'its memory reads {string} and its CPUs number {int}',
  async (world, meminfo: string, cpus: number) => {
    const root = world.probeRoot!;
    await writeFile(join(root, 'proc/meminfo'), `${meminfo}\n`);
    await writeFile(join(root, 'bin/nproc'), `#!/bin/sh\necho ${cpus}\n`, {
      mode: 0o755,
    });
  }
);

When('the probe runs there', (world) => {
  const root = world.probeRoot!;
  const result = spawnSync('/bin/sh', ['-c', platformProbe(root)], {
    env: { ...process.env, PATH: `${root}/bin:${process.env['PATH'] ?? ''}` },
    encoding: 'utf8',
  });
  world.probeOutput = result.stdout;
});

Then('it prints the environment {string}', (world, environment: string) => {
  expect(world.probeOutput?.split('\n')[3]).toBe(environment);
});

Then('it prints the hypervisor {string}', (world, hypervisor: string) => {
  expect(world.probeOutput?.split('\n')[4]).toBe(hypervisor);
});

Then(
  'it prints {int} CPUs and {int} MiB of memory',
  (world, cpus: number, memory: number) => {
    const lines = world.probeOutput?.split('\n') ?? [];
    expect([lines[5], lines[6]]).toEqual([String(cpus), String(memory)]);
  }
);

Then('the machine class is recorded as {string}', (world, summary: string) => {
  expect(evaluateMachineClass(world.probeOutput ?? '')).toEqual({
    id: 'platform:machine-class',
    summary,
  });
});

When(
  'a worker reports {int} CPUs, {int} MiB of memory and a {int} MiB root filesystem',
  (world, cpus: number, memory: number, disk: number) => {
    world.size = evaluateSize(
      `ubuntu\n26.04\nx86_64\nmachine\nkvm\n${cpus}\n${memory}\n${disk}\n`
    );
  }
);

Then(
  /^the "platform:worker-size" check says the worker is (supported|not supported), with "([^"]*)"$/,
  (world, verdict: string, summary: string) => {
    expect(world.size).toMatchObject({
      id: 'platform:worker-size',
      supported: verdict === 'supported',
    });
    expect(world.size?.summary).toStartWith(summary);
  }
);

Then('a worker that reports no size gets no size check', () => {
  expect(evaluateSize('ubuntu\n26.04\nx86_64\nmachine\n')).toBeNull();
});

Then(
  'the fleet configuration refuses a worker declared as {string}',
  (_world, os: string) => {
    expect(() =>
      parseDefinition({
        ...example,
        workers: [{ id: 'worker-a', ssh: 'worker-a', os }],
      })
    ).toThrow('Invalid fleet definition');
  }
);

Then('the worker platforms are:', (_world, table: DataTable) => {
  expect(
    WORKER_PLATFORMS.map((platform) => ({
      family: platform.family,
      label: platform.label,
      policy: platform.policy,
      packageManager: platform.packageManager,
      serviceManager: platform.serviceManager,
      sessionModel: platform.sessionModel,
    }))
  ).toEqual(table.hashes() as never);
});

Then(
  'the worker platform {string} accepts the releases:',
  (_world, family: string, table: DataTable) => {
    expect(
      workerPlatform(family)?.releases.map((entry) => ({
        release: entry.release,
        codename: entry.codename,
        architectures: entry.architectures.join(', '),
      }))
    ).toEqual(table.hashes() as never);
  }
);
