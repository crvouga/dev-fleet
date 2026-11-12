import { expect } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { rules } from './steps';

/** The heartbeat workflow a consumer calls, run here with a stand-in for the
 * AWS CLI that serves the heartbeat the scenario describes.
 */
const { Given, When, Then } = rules;

interface Called {
  on: {
    workflow_call?: {
      inputs: Record<string, unknown>;
      secrets: Record<string, unknown>;
    };
  };
  jobs: Record<
    string,
    { steps: { run?: string; env?: Record<string, string> }[] }
  >;
}

const PATH = resolve(
  import.meta.dir,
  '../../.github/workflows/fleet-heartbeat.yml'
);
const heartbeat = (): Called => parse(readFileSync(PATH, 'utf8')) as Called;

const state = new WeakMap<
  object,
  { watch: string | null; exit: number; output: string }
>();
const of = (world: object) => {
  if (!state.has(world))
    state.set(world, { watch: null, exit: -1, output: '' });
  return state.get(world)!;
};

Then(
  'the heartbeat workflow can be called with the inputs:',
  (_world, table) => {
    const call = heartbeat().on.workflow_call;
    expect(call).toBeDefined();
    expect(Object.keys(call!.inputs).sort()).toEqual(table.list().sort());
  }
);

Then('the heartbeat workflow needs the secrets:', (_world, table) => {
  expect(Object.keys(heartbeat().on.workflow_call!.secrets).sort()).toEqual(
    table.list().sort()
  );
});

Given(
  /^the bucket holds a heartbeat from (\d+) minutes ago, with "([^"]*)" degraded$/,
  (world, minutes: string, node: string) => {
    of(world).watch = JSON.stringify({
      version: 1,
      heartbeatAt: new Date(
        Date.now() - Number(minutes) * 60_000
      ).toISOString(),
      nodes: node
        ? { [node]: { state: 'degraded', since: '', notifiedAt: null } }
        : {},
    });
  }
);

Given('the bucket holds no heartbeat', (world) => {
  of(world).watch = null;
});

When(
  'the heartbeat workflow runs with a limit of {int} minutes',
  (world, limit: number) => {
    const step = Object.values(heartbeat().jobs)[0]!.steps[0]!;
    const directory = mkdtempSync(join(tmpdir(), 'heartbeat-'));
    try {
      const fixture = join(directory, 'fixture.json');
      if (of(world).watch !== null) writeFileSync(fixture, of(world).watch!);
      // `aws s3 cp SOURCE DESTINATION …` copies the fixture, if there is one.
      const aws = join(directory, 'aws');
      writeFileSync(
        aws,
        `#!/bin/sh\n[ -f "${fixture}" ] || exit 1\ncp "${fixture}" "$4"\n`
      );
      chmodSync(aws, 0o755);
      const result = Bun.spawnSync(['bash', '-c', step.run!], {
        cwd: directory,
        env: {
          PATH: `${directory}:${process.env['PATH']}`,
          BUCKET: 'bucket',
          ENDPOINT: '',
          PREFIX: 'dev-fleet',
          MAX_AGE_MINUTES: String(limit),
        },
      });
      of(world).exit = result.exitCode;
      of(world).output = result.stdout.toString() + result.stderr.toString();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

Then(/^the heartbeat check (passes|fails)$/, (world, verdict: string) => {
  expect(of(world).exit === 0).toBe(verdict === 'passes');
});

Then('the heartbeat check says {string}', (world, text: string) => {
  expect(of(world).output).toContain(text);
});
