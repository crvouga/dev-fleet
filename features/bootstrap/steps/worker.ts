import { expect } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

export const worker = steps<BootstrapWorld>();
const { Given, When, Then } = worker;

const checkout = resolve(import.meta.dir, '../../..');
const MiB = 1024 * 1024;

// ── The T3 archive ───────────────────────────────────────────────────────

interface Member {
  name: string;
  content: string;
  /** Permission bits; absent for a link. */
  mode?: number;
}
const archive = part(() => ({
  released: undefined as Member | undefined,
  installed: undefined as Member | undefined,
  ran: undefined as SpawnSyncReturns<string> | undefined,
}));
const octal = (mode: number): number => parseInt(String(mode), 8);

/** Builds the archive and the installation the scenario describes in a
 * temporary directory and asks the verifier itself whether they match.
 */
const VERIFY = `
import importlib.util, io, json, os, sys, tarfile, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('verify', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
released, installed = json.loads(sys.argv[2]), json.loads(sys.argv[3])
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    archive = root / 'release.tar.gz'
    with tarfile.open(archive, 'w:gz') as target:
        data = released['content'].encode()
        entry = tarfile.TarInfo(released['name'])
        # Built by another user: never the identity of this installation.
        entry.uid = os.getuid() + 1234
        entry.gid = os.getgid() + 1234
        entry.mode = released['mode']
        entry.size = len(data)
        target.addfile(entry, io.BytesIO(data))
    (root / 'installed').mkdir()
    path = root / 'installed' / installed['name']
    if 'mode' in installed:
        path.write_bytes(installed['content'].encode())
        path.chmod(installed['mode'])
    else:
        (root / 'outside').write_bytes(installed['content'].encode())
        path.symlink_to(root / 'outside')
    print(json.dumps(module.verify(archive, root / 'installed')))`;

Given(
  'a release archive, built by another user, that holds {string} with the content {string} and the mode {int}',
  (world, name: string, content: string, mode: number) => {
    archive(world).released = { name, content, mode: octal(mode) };
  }
);

Given(
  'an installation that holds {string} with the content {string} and the mode {int}',
  (world, name: string, content: string, mode: number) => {
    archive(world).installed = { name, content, mode: octal(mode) };
  }
);

Given(
  'an installation that holds {string} as a link to a file outside it with the content {string}',
  (world, name: string, content: string) => {
    archive(world).installed = { name, content };
  }
);

When('the installation is verified against the archive', (world) => {
  const { released, installed } = archive(world);
  archive(world).ran = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      VERIFY,
      join(checkout, 'bootstrap/verify-t3-archive.py'),
      JSON.stringify(released),
      JSON.stringify(installed),
    ],
    { encoding: 'utf8', timeout: 10_000 }
  );
});

Then(
  /^the installation (matches|does not match) the archive$/,
  (world, verdict: string) => {
    const ran = archive(world).ran!;
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toBe(verdict === 'matches');
  }
);

// ── The disk guard ───────────────────────────────────────────────────────

interface Look {
  current: Record<string, number>;
  victim: [string, number] | null;
}
const guard = part((world) => ({
  root: world.directory('disk-guard-'),
  low: undefined as boolean | undefined,
  threshold: undefined as number | undefined,
  /** How much each service wrote since the guard last looked, if it did. */
  wrote: undefined as ((service: string) => number) | undefined,
  look: undefined as Look | undefined,
}));

/** The guard's own selection, from its own reading of a cgroup tree. */
const DECIDE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
current = guard.leaf_writes(sys.argv[2])
print(json.dumps({'current': current, 'victim': guard.choose_victim(json.loads(sys.argv[3]), current, sys.argv[4] == '1', int(sys.argv[5]))}))`;

function decide(world: BootstrapWorld, previous: Record<string, number>): Look {
  const { root, low, threshold } = guard(world);
  if (low === undefined || threshold === undefined)
    throw new Error('Say how full the disk is and what a runaway is.');
  const out = Bun.spawnSync([
    'python3',
    '-I',
    '-B',
    '-c',
    DECIDE,
    join(checkout, 'ansible/ubuntu/disk-guard.py'),
    root,
    JSON.stringify(previous),
    low ? '1' : '0',
    String(threshold),
  ]);
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout.toString()) as Look;
}

Given(
  'these services have written to disk since they started:',
  (world, table: DataTable) => {
    const rows = table.hashes() as { service: string; written: string }[];
    for (const { service, written } of rows) {
      mkdirSync(join(guard(world).root, service), { recursive: true });
      writeFileSync(
        join(guard(world).root, service, 'io.stat'),
        `259:0 rbytes=1 wbytes=${parseInt(written) * MiB} rios=1 wios=1\n`
      );
    }
  }
);

Given(
  "{string} has totals of its own that are not a service's",
  (world, slice: string) => {
    writeFileSync(
      join(guard(world).root, slice, 'io.stat'),
      'parent totals are ignored\n'
    );
  }
);

Given(
  'a service that wrote {int} MiB since the guard last looked is a runaway',
  (world, megabytes: number) => {
    guard(world).threshold = megabytes * MiB;
  }
);

Given(
  /^the disk (is below its floor of free space|has free space)$/,
  (world, space: string) => {
    guard(world).low = space !== 'has free space';
  }
);

Given(
  /^since the guard last looked, "([^"]*)" wrote (\d+) MiB and every other service (\d+) MiB$/,
  (world, service: string, megabytes: number, others: number) => {
    guard(world).wrote = (path) =>
      (path.endsWith(service) ? Number(megabytes) : Number(others)) * MiB;
  }
);

Given(
  /^since the guard last looked, every service wrote (\d+) MiB$/,
  (world, megabytes: number) => {
    guard(world).wrote = () => Number(megabytes) * MiB;
  }
);

When(/^the guard looks(?: for the first time)?$/, (world) => {
  const { wrote } = guard(world);
  // What the guard recorded last time: each total, less what was written since.
  const previous = wrote
    ? Object.fromEntries(
        Object.entries(decide(world, {}).current).map(([path, total]) => [
          path,
          total - wrote(path),
        ])
      )
    : {};
  guard(world).look = decide(world, previous);
});

Then('no service is chosen', (world) => {
  expect(guard(world).look!.victim).toBeNull();
});

Then(
  '{string} is chosen, having written {int} MiB',
  (world, service: string, megabytes: number) => {
    const { victim } = guard(world).look!;
    expect(victim?.[0]).toEndWith(service);
    expect(victim?.[1]).toBe(megabytes * MiB);
  }
);

// ── The T3 watchdog ──────────────────────────────────────────────────────

const watchdog = part((world) => ({
  directory: world.directory('t3-health-'),
  headless: false,
  desktop: false,
  healthy: false,
  prepared: false,
}));
const log = (world: BootstrapWorld): string =>
  join(watchdog(world).directory, 'calls');

/** Runs the watchdog with a `systemctl` and a `curl` that only record how
 * they were called and answer as the scenario says.
 */
function watch(world: BootstrapWorld): number {
  const state = watchdog(world);
  const { directory, headless, desktop, healthy } = state;
  const stand = (name: string, body: string): void => {
    writeFileSync(
      join(directory, name),
      `#!/bin/sh\necho "${name} $*" >> ${log(world)}\n${body}\n`
    );
    chmodSync(join(directory, name), 0o755);
  };
  if (!state.prepared) {
    writeFileSync(log(world), '');
    stand(
      'systemctl',
      `case "$*" in *"is-active --quiet t3code.service") exit ${headless ? 0 : 3};; *is-active*) exit ${desktop ? 0 : 3};; esac`
    );
    stand('curl', `exit ${healthy ? 0 : 28}`);
    state.prepared = true;
  }
  return Bun.spawnSync(
    ['/bin/sh', join(checkout, 'ansible/ubuntu/t3-health.sh')],
    { env: { PATH: `${directory}:/usr/bin:/bin`, XDG_RUNTIME_DIR: directory } }
  ).exitCode;
}

Given(
  /^the headless T3 server is (running|stopped)$/,
  (world, state: string) => {
    watchdog(world).headless = state === 'running';
  }
);

Given(
  /^the T3 desktop service is (running|stopped)$/,
  (world, state: string) => {
    watchdog(world).desktop = state === 'running';
  }
);

Given(
  /^T3 (answers|does not answer) its health check$/,
  (world, answer: string) => {
    watchdog(world).healthy = answer === 'answers';
  }
);

Given(/^the watchdog has run (\d+) times?$/, (world, times: number) => {
  for (let run = 0; run < Number(times); run++) watch(world);
});

When('the watchdog runs', (world) => {
  world.exit = watch(world);
});

Then('it runs {string}', (world, command: string) => {
  expect(readFileSync(log(world), 'utf8')).toContain(command);
});

Then('it starts and restarts nothing', (world) => {
  expect(readFileSync(log(world), 'utf8')).not.toMatch(/start|restart/);
});

Then('it has restarted nothing', (world) => {
  expect(readFileSync(log(world), 'utf8')).not.toContain('restart');
});
