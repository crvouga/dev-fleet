import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { smoke } from '../../../bootstrap/package-smoke';
import { steps } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

export const packageSmoke = steps<BootstrapWorld>();
const { Given, When } = packageSmoke;

/** A stand-in for the package: a devfleet that prints what the real one does. */
const release = part((world) => ({
  source: world.directory('devfleet-release-'),
  version: '',
  commit: '',
  failing: '',
}));

const launcher = (failing: string) => `#!/usr/bin/env node
const [version, commit] = ['__VERSION__', '__COMMIT__'];
const args = process.argv.slice(2).join(' ');
if (args === ${JSON.stringify(failing)}) process.exit(1);
if (args === '--version') console.log(version + ' (commit ' + commit + ')');
else if (args === 'fleet-state --example') console.log(JSON.stringify({ $schema: './schema.json' }));
else process.exit(2);
`;

function write(world: BootstrapWorld): void {
  const state = release(world);
  mkdirSync(join(state.source, 'bin'), { recursive: true });
  writeFileSync(
    join(state.source, 'bin', 'devfleet.mjs'),
    launcher(state.failing)
      .replace('__VERSION__', state.version)
      .replace('__COMMIT__', state.commit)
  );
}

function manifest(
  world: BootstrapWorld,
  change: (json: Record<string, unknown>) => void
): void {
  const path = join(release(world).source, 'package.json');
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  change(json);
  writeFileSync(path, JSON.stringify(json));
}

Given(
  'a packed release {string} from commit {string}',
  (world, version: string, commit: string) => {
    const state = release(world);
    Object.assign(state, { version, commit });
    writeFileSync(
      join(state.source, 'package.json'),
      JSON.stringify({
        name: 'devfleet-fixture',
        version,
        gitHead: commit,
        bin: { devfleet: './bin/devfleet.mjs' },
        files: ['bin'],
      })
    );
    write(world);
  }
);

Given(
  'its package.json points the devfleet command at {string}',
  (world, path: string) => {
    manifest(world, (json) => {
      json['bin'] = { devfleet: path };
    });
  }
);

Given('its devfleet fails {string}', (world, command: string) => {
  release(world).failing = command;
  write(world);
});

async function installAndRun(world: BootstrapWorld, version?: string) {
  const state = release(world);
  const out = world.directory('devfleet-packed-');
  const packed = spawnSync(
    'npm',
    ['pack', '--silent', '--pack-destination', out],
    { cwd: state.source, encoding: 'utf8' }
  );
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const tarball = join(out, packed.stdout.trim().split('\n').at(-1)!);
  await world.attempt(() =>
    smoke(tarball, { version: version ?? state.version, commit: state.commit })
  );
}

When('the packed release is installed and run', (world) =>
  installAndRun(world)
);

When(
  'the packed release is installed and run, expecting {string}',
  (world, version: string) => installAndRun(world, version)
);
