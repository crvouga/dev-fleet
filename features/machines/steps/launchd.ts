import { expect } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import macos from '../../../ansible/macos/policy.json';
import { launchdPlist } from '../../../src/platform/launchd';
import type { ScheduledJob } from '../../../src/platform/types';
import { runCommand } from '../../../src/runner';
import { machines, type MachinesWorld } from './world';

const { Given, When, Then } = machines;
const root = resolve(import.meta.dir, '../../..');

/** What macOS says about each property list, by path. */
const linted = new WeakMap<MachinesWorld, Map<string, boolean>>();
const job = new WeakMap<MachinesWorld, ScheduledJob>();

async function lint(world: MachinesWorld, paths: string[]): Promise<void> {
  const results = new Map<string, boolean>();
  for (const path of paths)
    results.set(path, (await runCommand(['plutil', '-lint', path])).ok);
  linted.set(world, results);
}

Given(
  'a scheduled job {string} that runs {string} {string} every {int} seconds',
  (
    world,
    label: string,
    command: string,
    argument: string,
    seconds: number
  ) => {
    job.set(world, {
      label,
      command: [command, argument],
      intervalSeconds: seconds,
      logDir: '/tmp/a & b',
      env: { PATH: '/usr/bin:/bin', NOTE: '<x> & "y"' },
    });
  }
);

When(
  'every launchd job under {string} is linted by macOS',
  async (world, directory: string) => {
    const paths = readdirSync(join(root, directory))
      .filter((name) => name.endsWith('.plist'))
      .map((name) => join(root, directory, name));
    expect(paths.length).toBeGreaterThan(0);
    await lint(world, paths);
  }
);

When('its launchd job is rendered and linted by macOS', async (world) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-launchd-'));
  world.defer(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, 'job.plist');
  writeFileSync(path, launchdPlist(job.get(world)!));
  await lint(world, [path]);
});

const rendered = new WeakMap<MachinesWorld, string>();

When(
  /^the fleet-watch job of "([^"]+)" is rendered for the home "([^"]+)", every (\d+) minutes, and linted by macOS$/,
  async (world, playbook: string, home: string, minutes: string) => {
    const plays = parse(readFileSync(join(root, playbook), 'utf8')) as {
      tasks?: Record<string, unknown>[];
    }[];
    const content = plays
      .flatMap((play) => play.tasks ?? [])
      .map(
        (task) =>
          task['ansible.builtin.copy'] as Record<string, string> | undefined
      )
      .find((copy) => copy?.['dest'] === '{{ watch_plist }}')?.['content'];
    expect(content).toBeDefined();
    // The play's variables, as manager.yml computes them.
    const values: Record<string, string> = {
      watch_home: home,
      watch_label: macos.fleetWatch.label,
      watch_logs: `${home}/${macos.jobLogs.directory}`,
      'watch_minutes | int * 60': String(Number(minutes) * 60),
    };
    const plist = content!.replace(
      /\{\{\s*(.+?)\s*\}\}/g,
      (_, name: string) => {
        expect(values[name]).toBeDefined();
        return values[name]!;
      }
    );
    rendered.set(world, plist);
    const scratch = mkdtempSync(join(tmpdir(), 'fleet-watch-'));
    world.defer(() => rmSync(scratch, { recursive: true, force: true }));
    const path = join(scratch, 'watch.plist');
    writeFileSync(path, plist);
    await lint(world, [path]);
  }
);

Then(
  /^the rendered job runs "([^"]+)" every (\d+) seconds from "([^"]+)"$/,
  (world, command: string, seconds: string, directory: string) => {
    const plist = rendered.get(world)!;
    expect(plist).toContain(`<string>${command}</string>`);
    expect(plist).toContain(
      `<key>StartInterval</key><integer>${seconds}</integer>`
    );
    expect(plist).toContain(
      `<key>WorkingDirectory</key><string>${directory}</string>`
    );
  }
);

Then('each is valid', (world) => {
  const invalid = [...(linted.get(world) ?? new Map<string, boolean>())]
    .filter(([, ok]) => !ok)
    .map(([path]) => path);
  expect(linted.get(world)?.size).toBeGreaterThan(0);
  expect(invalid).toEqual([]);
});
