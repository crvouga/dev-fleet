import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectConfig, useProjectConfig } from '../../src/cli/project';
import { packageInfo } from '../../src/package-info';
import { resolveSettings } from '../../src/cli/settings';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const FLEET = JSON.stringify({ version: 3, manager: { id: 'manager-mac' } });

/** A project of someone's own: a fleet.json and directories below it. */
async function project(): Promise<{ root: string; nested: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fleet-project-')));
  roots.push(root);
  const nested = join(root, 'machines/notes');
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

test('the CLI uses the fleet.json of the project it is run from', async () => {
  const { root, nested } = await project();
  expect(projectConfig(nested)).toBeNull();
  writeFileSync(join(root, 'fleet.json'), FLEET);
  expect(projectConfig(root)).toBe(join(root, 'fleet.json'));
  expect(projectConfig(nested)).toBe(join(root, 'fleet.json'));
  const env: NodeJS.ProcessEnv = {};
  expect(useProjectConfig(env, nested)).toBe(join(root, 'fleet.json'));
  // Named for the command and everything it starts in another directory.
  expect(env['DEVFLEET_CONFIG']).toBe(join(root, 'fleet.json'));
});

test('another tool’s fleet.json is passed over and a named file wins', async () => {
  const { root, nested } = await project();
  writeFileSync(join(root, 'fleet.json'), FLEET);
  // Closer to the working directory, but not a fleet configuration.
  writeFileSync(join(nested, 'fleet.json'), '{"vehicles":[]}');
  writeFileSync(join(root, 'machines/fleet.json'), 'not json');
  expect(projectConfig(nested)).toBe(join(root, 'fleet.json'));
  // DEVFLEET_CONFIG names a file elsewhere; a relative one is anchored here,
  // because fleet-sync re-runs itself from another directory.
  const env: NodeJS.ProcessEnv = { DEVFLEET_CONFIG: 'other/fleet.json' };
  expect(useProjectConfig(env, nested)).toBe(join(nested, 'other/fleet.json'));
  expect(env['DEVFLEET_CONFIG']).toBe(join(nested, 'other/fleet.json'));
});

test('outside a project nothing is named and the stored configuration is used', async () => {
  const { nested } = await project();
  const env: NodeJS.ProcessEnv = {};
  expect(useProjectConfig(env, nested)).toBeNull();
  expect(env).toEqual({});
});

test('a published package knows the commit it is; a checkout does not', async () => {
  // This checkout: the manifest carries no version and no commit.
  expect(packageInfo()).toMatchObject({
    version: '0.0.0-development',
    revision: null,
  });
  const { root } = await project();
  const stamp = (gitHead: unknown, bugs?: unknown) =>
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@scope/dev-fleet',
        version: '1.4.0',
        gitHead,
        bugs,
      })
    );
  stamp('a'.repeat(40));
  expect(packageInfo(root)).toEqual({
    name: '@scope/dev-fleet',
    version: '1.4.0',
    revision: 'a'.repeat(40),
    issues: null,
  });
  // A fork sends its users to its own issue tracker, in either npm form.
  const issues = 'https://git.example.com/scope/dev-fleet/issues';
  for (const bugs of [issues, { url: issues }]) {
    stamp('a'.repeat(40), bugs);
    expect(packageInfo(root).issues).toBe(issues);
  }
  for (const bugs of ['issues', { email: 'bugs@example.com' }, 7]) {
    stamp('a'.repeat(40), bugs);
    expect(packageInfo(root).issues).toBeNull();
  }
  // Anything but a full commit is no revision to converge a fleet to.
  for (const gitHead of [
    'main',
    'a'.repeat(39),
    'A'.repeat(40),
    7,
    undefined,
  ]) {
    stamp(gitHead);
    expect(packageInfo(root).revision).toBeNull();
  }
});

test('run from a checkout, the workspace is the dev-fleet checkout the command is started in', async () => {
  const { root, nested } = await project();
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/fleet-manager-run.sh'), '#!/bin/sh\n');
  expect((await resolveSettings({}, nested, {})).workspace).toBe(root);
});
