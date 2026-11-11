import { expect } from 'bun:test';
import type { MachineDefinition } from '../../../src/definition';
import {
  convergeable,
  evaluatePlatform,
  type MachinePlatform,
} from '../../../src/machine/platform';
import {
  detectPlatformName,
  getPlatform,
  type PlatformName,
} from '../../../src/platform';
import { machines } from './world';

const { When, Then } = machines;

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
  'a machine declared as {string} answers the probe with {string}, {string} and {string}',
  (world, declared: string, family: string, release: string, cpu: string) => {
    world.baseline = evaluatePlatform(
      declared as MachinePlatform,
      `${family}\n${release}\n${cpu}\n`
    );
  }
);

Then(
  /^the "([^"]+)" check says the machine is (supported|not supported)$/,
  (world, id: string, verdict: string) => {
    expect(world.baseline).toMatchObject({
      id,
      supported: verdict === 'supported',
    });
  }
);

Then('the baseline is summarised as {string}', (world, summary: string) => {
  expect(world.baseline?.summary).toBe(summary);
});

Then(
  /^a machine declared as "([^"]+)" is (converged|not converged)$/,
  (_world, declared: string, verdict: string) => {
    const machine = { id: 'a', ssh: 'a', os: declared } as MachineDefinition;
    expect(convergeable(machine)).toBe(verdict === 'converged');
  }
);
