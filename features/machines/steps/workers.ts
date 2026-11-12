import { expect } from 'bun:test';
import { verifyResourceSafety } from '../../../src/platform/resource-verify';
import { auditUbuntu } from '../../../src/platform/ubuntu-audit';
import { verifyUbuntuBoot } from '../../../src/platform/ubuntu-verify';
import { pinnedPackage } from '../../../src/worker-host-checks';
import {
  browserPackagePins,
  packagePins,
  tailscalePins,
} from '../../../src/platform/ubuntu-release';
import { workerPlatform } from '../../../src/platform/ubuntu-worker';
import ubuntu from '../../../ansible/ubuntu/policy.json';
import type { DataTable } from '../../support/gherkin';
import { machines } from './world';

const { When, Then } = machines;

When(
  'the resource safety of the worker whose home is {string} is measured',
  async (world, home: string) => {
    world.checks = await verifyResourceSafety(home, world.run);
  }
);

When(
  'the boot policy of the worker is measured for the user {string}',
  async (world, user: string) => {
    world.checks = await verifyUbuntuBoot(user, world.run);
  }
);

When('the worker is audited', async (world) => {
  world.audit = await auditUbuntu(world.run);
});

Then('the audit says the worker is not supported', (world) => {
  expect(world.audit?.supported).toBe(false);
});

Then('the audit lists exactly these packages:', (world, table: DataTable) => {
  expect(world.audit?.packages).toEqual(
    Object.fromEntries(
      table.hashes().map((row) => [row['package'], row['version']])
    )
  );
});

Then('the audit does not contain {string}', (world, text: string) => {
  expect(world.audit).toBeDefined();
  expect(JSON.stringify(world.audit)).not.toContain(text);
});

When(
  'the package {string} pinned at {string} is measured installed at {string}',
  (world, name: string, pinned: string, installed: string) => {
    world.checks = [pinnedPackage(name, pinned, installed || undefined)];
  }
);

When(
  'the pins of a release that pins {string} at {string} are read',
  (world, name: string, version: string) => {
    world.pins = packagePins({
      release: '00.00',
      codename: 'example',
      architectures: ['amd64'],
      packages: { [name]: version },
    });
  }
);

Then(
  '{string} is pinned at {string}',
  (world, name: string, version: string) => {
    expect(world.pins?.[name]).toBe(version);
  }
);

Then(
  'every package but {string} is pinned at the common pin of the Ubuntu policy',
  (world, except: string) => {
    const common: Record<string, string> = ubuntu.packages;
    for (const [name, version] of Object.entries(common))
      if (name !== except) expect(world.pins?.[name]).toBe(version);
  }
);

/** A release of the policy's shape that differs from the common pins only
 * where the scenario says. */
const exampleRelease = {
  release: '00.00',
  codename: 'example',
  architectures: ['amd64'],
};

When(
  'the browser library pins of a release that pins {string} at {string} are read',
  (world, name: string, version: string) => {
    world.browserPins = browserPackagePins({
      ...exampleRelease,
      browserPackages: { [name]: version },
    });
  }
);

Then(
  'every browser library but {string} is pinned at the common pin of the Ubuntu policy',
  (world, except: string) => {
    const common: Record<string, string> = ubuntu.browser.packages;
    for (const [name, version] of Object.entries(common))
      if (name !== except) expect(world.browserPins?.[name]).toBe(version);
  }
);

When(
  /^the Tailscale pins of a release that names (?:the key digest "([^"]+)"|no key digest) are read$/,
  (world, digest: string | undefined) => {
    world.tailscale = tailscalePins({
      ...exampleRelease,
      ...(digest ? { tailscaleKeySha256: digest } : {}),
    });
  }
);

Then(
  /^the Tailscale key digest is (?:"([^"]+)"|the Ubuntu policy's)$/,
  (world, digest: string | undefined) => {
    expect(world.tailscale?.keySha256).toBe(
      digest ?? ubuntu.tailscale.keySha256
    );
  }
);

Then('the Tailscale version is the one the Ubuntu policy pins', (world) => {
  expect(world.tailscale?.version).toBe(ubuntu.tailscale.version);
});

When(
  'the worker platform {string} reads the pins of release {string}',
  (world, family: string, version: string) => {
    const platform = workerPlatform(family);
    const release = platform?.release(version);
    expect(release).toBeDefined();
    world.pins = platform!.packagePins(release);
    world.browserPins = platform!.browserPackagePins(release);
  }
);

Then(
  'the browser library {string} is pinned at {string}',
  (world, name: string, version: string) => {
    expect(world.browserPins?.[name]).toBe(version);
  }
);
