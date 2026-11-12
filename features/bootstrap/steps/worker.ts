import { expect } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { Database } from 'bun:sqlite';
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
  /** The worker's session type is headless (t3code-headless.service). */
  server: false,
  retires: true,
  session: true,
  desktop: false,
  healthy: false,
  running: '',
  installed: '',
  idle: true,
  output: '',
}));
const log = (world: BootstrapWorld): string =>
  join(watchdog(world).directory, 'calls');
const calls = (world: BootstrapWorld): string[] =>
  readFileSync(log(world), 'utf8').split('\n').filter(Boolean);
const marker = (world: BootstrapWorld): string =>
  join(watchdog(world).directory, 'personal-t3-restart-pending');

/** Runs the watchdog with a `systemctl`, `curl`, `sudo` and `python3` that
 * only record how they were called and answer as the scenario says, and an
 * installed app whose release is the one the scenario names.
 */
function watch(world: BootstrapWorld): number {
  const state = watchdog(world);
  const { directory } = state;
  const stand = (name: string, body: string): void => {
    writeFileSync(
      join(directory, name),
      `#!/bin/sh\necho "${name} $*" >> ${log(world)}\n${body}\n`
    );
    chmodSync(join(directory, name), 0o755);
  };
  const exit = (yes: boolean): number => (yes ? 0 : 3);
  if (!existsSync(log(world))) writeFileSync(log(world), '');
  stand(
    'systemctl',
    [
      'case "$*" in',
      `  *"t3code.service") case "$*" in *disable*) exit ${exit(state.retires)};; *) exit ${exit(state.headless)};; esac;;`,
      `  *"is-enabled --quiet t3code-headless.service") exit ${exit(state.server)};;`,
      `  *"show --property=ExecStart --value t3code-headless.service") echo "{ path=/home/dev/.local/share/personal/tools/t3-${state.installed}-linux-x64/t3 ; argv[]=/home/dev/.local/share/personal/tools/t3-${state.installed}-linux-x64/t3 serve --mode web ; }";;`,
      `  *"is-active --quiet graphical-session.target") exit ${exit(state.session)};;`,
      `  *is-active*) exit ${exit(state.desktop)};;`,
      'esac',
    ].join('\n')
  );
  stand(
    'curl',
    state.healthy
      ? `printf '%s' '{"environmentId":"e","serverVersion":"${state.running}"}'`
      : 'exit 28'
  );
  stand('sudo', '');
  stand('python3', `exit ${state.idle ? 0 : 1}`);
  const app = join(directory, 'app');
  mkdirSync(app, { recursive: true });
  if (state.installed)
    writeFileSync(
      join(app, '.personal-fleet-version'),
      `T3-Code-${state.installed}-amd64.deb`
    );
  const ran = Bun.spawnSync(
    ['/bin/sh', join(checkout, 'ansible/ubuntu/t3-health.sh')],
    {
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        XDG_RUNTIME_DIR: directory,
        HOME: directory,
        T3_DESKTOP_DIR: app,
      },
    }
  );
  state.output = ran.stdout.toString();
  return ran.exitCode;
}

Given(
  /^the headless T3 server is (running|stopped)$/,
  (world, state: string) => {
    watchdog(world).headless = state === 'running';
  }
);

Given('the headless T3 server cannot be stopped', (world) => {
  watchdog(world).retires = false;
});

Given('the worker runs a headless session', (world) => {
  watchdog(world).server = true;
});

Given(
  /^the T3 server of the headless session is (running|stopped)$/,
  (world, state: string) => {
    watchdog(world).server = true;
    watchdog(world).desktop = state === 'running';
  }
);

Given('there is no graphical session', (world) => {
  watchdog(world).session = false;
});

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

Given(
  'T3 answers its health check as release {string}',
  (world, version: string) => {
    watchdog(world).healthy = true;
    watchdog(world).running = version;
  }
);

Given('the installed release is {string}', (world, version: string) => {
  watchdog(world).installed = version;
});

Given(/^T3 runs (no|an) agent turn$/, (world, turn: string) => {
  watchdog(world).idle = turn === 'no';
});

Given('a restart for the staged policy is pending', (world) => {
  writeFileSync(marker(world), '1800000000\n');
});

Given(/^the watchdog has run (\d+) times?$/, (world, times: number) => {
  for (let run = 0; run < Number(times); run++) watch(world);
});

When('the watchdog runs', (world) => {
  world.exit = watch(world);
});

When('the watchdog runs {int} times', (world, times: number) => {
  for (let run = 0; run < times; run++) world.exit = watch(world);
});

Then('it runs {string}', (world, command: string) => {
  expect(calls(world)).toContain(command);
});

Then('it does not run {string}', (world, command: string) => {
  expect(calls(world)).not.toContain(command);
});

Then(
  'it runs {string} before {string}',
  (world, first: string, second: string) => {
    const ran = calls(world);
    expect(ran).toContain(first);
    expect(ran.indexOf(first)).toBeLessThan(ran.indexOf(second));
  }
);

Then('it ran {string} {int} times', (world, command: string, times) => {
  expect(calls(world).filter((line) => line === command)).toHaveLength(times);
});

Then('it says {string}', (world, text: string) => {
  expect(watchdog(world).output).toContain(text);
});

Then(/^the pending restart is (kept|cleared)$/, (world, kept: string) => {
  expect(existsSync(marker(world))).toBe(kept === 'kept');
});

Then('it starts and restarts nothing', (world) => {
  expect(readFileSync(log(world), 'utf8')).not.toMatch(/start|restart/);
});

Then('it has restarted nothing', (world) => {
  expect(readFileSync(log(world), 'utf8')).not.toContain('restart');
});

// ── Whether T3 runs an agent turn ────────────────────────────────────────

const turns = part((world) => ({
  state: join(world.directory('t3-idle-'), 'statev2.sqlite'),
  output: '',
}));

Given(
  'T3 has recorded runs with these statuses:',
  (world, table: DataTable) => {
    const database = new Database(turns(world).state);
    database.run(
      'CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)'
    );
    for (const [index, status] of table.list().entries())
      database.run(
        'INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)',
        [`run-${index}`, status]
      );
    database.close();
  }
);

Given('T3 keeps its state in a database without runs', (world) => {
  new Database(turns(world).state).close();
});

When('T3 is asked whether it runs an agent turn', (world) => {
  const ran = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      join(checkout, 'ansible/ubuntu/t3-idle.py'),
      '--state',
      turns(world).state,
    ],
    { encoding: 'utf8' }
  );
  world.exit = ran.status;
  turns(world).output = ran.stdout;
});

Given('T3 has recorded these runs:', (world, table: DataTable) => {
  const database = new Database(turns(world).state);
  database.run(
    'CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT)'
  );
  for (const [index, run] of table.hashes().entries())
    database.run(
      'INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?)',
      [
        `run-${index}`,
        run['status']!,
        run['requested at']!,
        run['completed at'] || null,
        run['what the session holds']!,
      ]
    );
  database.close();
});

When('T3 is asked for its agent activity', (world) => {
  const ran = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      join(checkout, 'ansible/ubuntu/t3-idle.py'),
      '--state',
      turns(world).state,
      '--activity',
    ],
    { encoding: 'utf8' }
  );
  world.exit = ran.status;
  turns(world).output = ran.stdout;
});

Then('the answer is exactly:', (world, text: string) => {
  expect(JSON.parse(turns(world).output)).toEqual(JSON.parse(text));
});

Then('the answer does not say {string}', (world, text: string) => {
  expect(turns(world).output).not.toContain(text);
});

Then('the answer says {string}', (world, text: string) => {
  expect(turns(world).output).toContain(text);
});

const LOW = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
print(json.dumps(guard.low_paths({'/': int(sys.argv[2])}, {'/': float(sys.argv[3])}, int(sys.argv[4]), float(sys.argv[5]))))`;

When(
  /^the guard measures a filesystem with (\d+) MiB and ([\d.]+)% of its inodes free, against floors of (\d+) MiB and ([\d.]+)% of inodes$/,
  (world, free: string, inodes: string, floor: string, inodeFloor: string) => {
    const out = Bun.spawnSync([
      'python3',
      '-I',
      '-B',
      '-c',
      LOW,
      join(checkout, 'ansible/ubuntu/disk-guard.py'),
      String(Number(free) * MiB),
      inodes,
      String(Number(floor) * MiB),
      inodeFloor,
    ]);
    expect(out.exitCode).toBe(0);
    guard(world).low =
      (JSON.parse(out.stdout.toString()) as string[]).length > 0;
  }
);

Then(/^the filesystem is (above|below) its floors$/, (world, side: string) => {
  expect(guard(world).low).toBe(side === 'below');
});
