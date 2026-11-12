import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import example from '../../../examples/fleet.json';
import { parseDefinition } from '../../../src/definition';
import {
  evaluateEnvironment,
  evaluatePlatform,
  platformProbe,
} from '../../../src/machine/platform';
import type { DataTable } from '../../support/gherkin';
import {
  detectPlatformName,
  getPlatform,
  type PlatformName,
} from '../../../src/platform';
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

Then(
  'the fleet configuration refuses a worker declared as {string}',
  (_world, os: string) => {
    expect(() =>
      parseDefinition({
        ...example,
        workers: [{ id: 'worker-a', ssh: 'worker-a', os }],
      })
    ).toThrow('Invalid Fleet definition');
  }
);
