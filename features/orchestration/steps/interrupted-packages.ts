import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { orchestration, type OrchestrationWorld } from '../support/world';

/** The prerequisites step of the remote bootstrap, cut from the script
 * between its markers with the function that names APT failures, and run in
 * a real shell. sudo, timeout, sleep, dpkg, dpkg-query and apt-get are
 * stand-ins that keep the package database as files.
 */
const { Given, When, Then } = orchestration;

const SCRIPT = resolve(
  import.meta.dir,
  '../../../bootstrap/fleet-remote-bootstrap.sh'
);

function segment(name: string): string {
  const text = readFileSync(SCRIPT, 'utf8');
  const begin = text.indexOf(`# ${name}: begin`);
  const end = text.indexOf(`# ${name}: end`);
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end);
}

const STAND_INS: Record<string, string> = {
  sudo: 'echo used >>"$S/sudo"\n[ "$1" = -n ] && shift\nexec "$@"',
  timeout: 'shift\nexec "$@"',
  sleep: 'echo "$*" >>"$S/slept"',
  'dpkg-query':
    'for a; do pkg=$a; done\ncat "$S/status/$pkg" 2>/dev/null || printf installed',
  dpkg: `case "$1" in
--audit)
  for f in "$S"/unconfigured/*; do
    [ ! -e "$f" ] || echo "The following packages have been unpacked but not yet configured: \${f##*/}"
  done
  exit 0;;
--configure)
  echo configure >>"$S/configured"
  n=$(cat "$S/locked" 2>/dev/null || echo 0)
  if [ "$n" -gt 0 ]; then
    echo $((n - 1)) >"$S/locked"
    echo 'dpkg: error: dpkg frontend lock was locked by another process with pid 4242' >&2
    exit 2
  fi
  if [ "$(cat "$S/mode" 2>/dev/null)" = finish ]; then
    for f in "$S"/unconfigured/*; do
      [ -e "$f" ] || continue
      printf installed >"$S/status/\${f##*/}"
      rm -f "$f"
    done
    exit 0
  fi
  echo 'dpkg: error processing package python3 (--configure):' >&2
  exit 1;;
esac
exit 2`,
  'apt-get': `installing=''
for a; do
  case "$a" in
    install) installing=1; printf install >>"$S/apt";;
    -*) ;;
    *) [ -z "$installing" ] || { printf ' %s' "$a" >>"$S/apt"; printf installed >"$S/status/$a"; };;
  esac
done
[ -z "$installing" ] || echo >>"$S/apt"`,
};

interface Packages {
  state: string;
  stdout?: string;
}
const runs = new WeakMap<OrchestrationWorld, Packages>();

function packages(world: OrchestrationWorld): Packages {
  let found = runs.get(world);
  if (!found) {
    const state = mkdtempSync(join(tmpdir(), 'devfleet-packages-'));
    world.defer(() => rmSync(state, { recursive: true, force: true }));
    for (const directory of ['bin', 'status', 'unconfigured', 'root'])
      mkdirSync(join(state, directory));
    for (const [name, body] of Object.entries(STAND_INS)) {
      const path = join(state, 'bin', name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    }
    found = { state };
    runs.set(world, found);
  }
  return found;
}

const read = (world: OrchestrationWorld, name: string): string => {
  const path = join(packages(world).state, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

Given(
  'the package {string} was unpacked and not configured when the run was cut off',
  (world, name: string) => {
    const { state } = packages(world);
    writeFileSync(join(state, 'status', name), 'unpacked');
    writeFileSync(join(state, 'unconfigured', name), '');
  }
);

Given('the bootstrap package {string} is not installed', (world, name) => {
  writeFileSync(
    join(packages(world).state, 'status', name as string),
    'not-installed'
  );
});

Given('dpkg finishes configuring what is unpacked', (world) => {
  writeFileSync(join(packages(world).state, 'mode'), 'finish');
});

Given('dpkg cannot finish configuring what is unpacked', (world) => {
  writeFileSync(join(packages(world).state, 'mode'), 'fail');
});

Given(
  'another package process holds the dpkg lock for the first {int} attempts',
  (world, attempts: number) => {
    writeFileSync(join(packages(world).state, 'locked'), `${attempts}`);
  }
);

Given('an earlier revision left its installation marker', (world) => {
  writeFileSync(
    join(packages(world).state, 'root', 'prerequisites-pending'),
    ''
  );
});

When('the prerequisites step runs', (world) => {
  const run = packages(world);
  const program = [
    'set -eu',
    `root='${join(run.state, 'root')}'`,
    "apt_log=''",
    'die() { echo "$1"; exit 1; }',
    segment('apt-failure'),
    segment('prerequisites'),
    'echo WENT_ON',
  ].join('\n');
  const result = spawnSync('/bin/sh', ['-c', program], {
    env: { PATH: `${join(run.state, 'bin')}:/usr/bin:/bin`, S: run.state },
    encoding: 'utf8',
    timeout: 20_000,
  });
  run.stdout = result.stdout.trim();
});

Then('the bootstrap goes on past its prerequisites', (world) => {
  expect(packages(world).stdout).toBe('WENT_ON');
});

Then(
  'the bootstrap stops its prerequisites with {string}',
  (world, code: string) => {
    expect(packages(world).stdout).toBe(code);
  }
);

Then(
  /^dpkg was asked to configure every unpacked package (\d+) times?$/,
  (world, count: string) => {
    expect(read(world, 'configured').split('\n').filter(Boolean).length).toBe(
      Number(count)
    );
  }
);

Then('the bootstrap waited {int} times for the lock', (world, count) => {
  expect(read(world, 'slept').split('\n').filter(Boolean)).toEqual(
    Array.from({ length: count as number }, () => '5')
  );
});

Then('APT installed nothing', (world) => {
  expect(read(world, 'apt')).toBe('');
});

Then('APT installed {string}', (world, name: string) => {
  expect(read(world, 'apt').trim()).toBe(`install ${name}`);
});

Then('the installation marker is gone', (world) => {
  expect(
    existsSync(join(packages(world).state, 'root', 'prerequisites-pending'))
  ).toBe(false);
});

Then('sudo was never used', (world) => {
  expect(read(world, 'sudo')).toBe('');
});
