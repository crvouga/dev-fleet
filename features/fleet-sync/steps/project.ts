import { expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectConfig, useProjectConfig } from '../../../src/cli/project';
import { resolveSettings } from '../../../src/cli/settings';
import { packageInfo, type PackageInfo } from '../../../src/package-info';
import type { DataTable } from '../../support/gherkin';
import {
  fleetSync,
  nested,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** A project of someone's own, and a package installed somewhere. */
interface Project {
  root: string;
  env: NodeJS.ProcessEnv;
  found: string | null | undefined;
  workspace: string | undefined;
  package: string | undefined;
  info: PackageInfo | undefined;
}
const projects = new WeakMap<FleetSyncWorld, Project>();

function project(world: FleetSyncWorld): Project {
  let found = projects.get(world);
  if (!found) {
    found = {
      root: temporary(world, 'fleet-project-'),
      env: {},
      found: undefined,
      workspace: undefined,
      package: undefined,
      info: undefined,
    };
    projects.set(world, found);
  }
  return found;
}

Given('a project with the directory {string}', (world, directory: string) => {
  mkdirSync(join(project(world).root, directory), { recursive: true });
});

Given("the project's {string} holds:", (world, path: string, text: string) => {
  const file = join(project(world).root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
});

Given('an environment that names nothing', (world) => {
  project(world).env = {};
});

Given(
  'an environment that names {string} as DEVFLEET_CONFIG',
  (world, path: string) => {
    project(world).env = { DEVFLEET_CONFIG: path };
  }
);

When(
  'the fleet configuration is looked for from {string}',
  (world, directory: string) => {
    const { root } = project(world);
    project(world).found = projectConfig(resolve(root, directory));
  }
);

When('devfleet is run in {string}', (world, directory: string) => {
  const { root, env } = project(world);
  project(world).found = useProjectConfig(env, join(root, directory));
});

When(
  'the settings are resolved in {string}',
  async (world, directory: string) => {
    const { root, env } = project(world);
    project(world).workspace = (
      await resolveSettings({}, join(root, directory), env)
    ).workspace;
  }
);

Then('no fleet configuration is found', (world) => {
  expect(project(world).found).toBeNull();
});

Then(
  /^(?:the fleet configuration found is|devfleet uses) the project's "([^"]*)"$/,
  (world, path: string) => {
    expect(project(world).found).toBe(join(project(world).root, path));
  }
);

Then('devfleet uses no project configuration', (world) => {
  expect(project(world).found).toBeNull();
});

Then(
  "the environment names the project's {string} as DEVFLEET_CONFIG",
  (world, path: string) => {
    const { root, env } = project(world);
    expect(env['DEVFLEET_CONFIG']).toBe(join(root, path));
  }
);

Then('the environment still names nothing', (world) => {
  expect(project(world).env).toEqual({});
});

Then('the workspace is the project', (world) => {
  expect(project(world).workspace).toBe(project(world).root);
});

// ── What a package says about itself ─────────────────────────────────────

Given('a package whose manifest is:', (world, manifest: string) => {
  const root = temporary(world, 'fleet-package-');
  writeFileSync(join(root, 'package.json'), manifest);
  project(world).package = root;
});

When('the package says what it is', (world) => {
  project(world).info = packageInfo(project(world).package!);
});

When('this checkout says what it is', (world) => {
  project(world).info = packageInfo();
});

Then('it says at least:', (world, table: DataTable) => {
  expect(project(world).info).toMatchObject(nested(table));
});

Then('it says exactly:', (world, table: DataTable) => {
  expect(project(world).info).toEqual(nested(table) as unknown as PackageInfo);
});

Then('its issue tracker is {string}', (world, url: string) => {
  expect(project(world).info?.issues).toBe(url);
});

Then('it names no issue tracker', (world) => {
  expect(project(world).info?.issues).toBeNull();
});

Then('it names no revision', (world) => {
  expect(project(world).info?.revision).toBeNull();
});
