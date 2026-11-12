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

// ── The CLI proxy health workflow ────────────────────────────────────────

interface Reusable {
  on: {
    workflow_call?: {
      inputs: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
  };
  jobs: Record<
    string,
    { steps: { run?: string; uses?: string; with?: Record<string, string> }[] }
  >;
}

const HEALTH = resolve(
  import.meta.dir,
  '../../.github/workflows/cliproxy-health.yml'
);
const healthText = (): string => readFileSync(HEALTH, 'utf8');
const health = (): Reusable => parse(healthText()) as Reusable;
const healthSteps = () =>
  Object.values(health().jobs).flatMap((job) => job.steps);

Then(
  'the CLI proxy health workflow can be called with the inputs:',
  (_world, table) => {
    const call = health().on.workflow_call;
    expect(call).toBeDefined();
    expect(Object.keys(call!.inputs).sort()).toEqual(table.list().sort());
  }
);

Then('the CLI proxy health workflow needs no secret', () => {
  expect(health().on.workflow_call!.secrets ?? {}).toEqual({});
  expect(healthText()).not.toContain('${{ secrets.');
});

Then(
  "the CLI proxy health workflow reads the Vault address from {string} of the caller's fleet configuration",
  (_world, path: string) => {
    const reading = healthSteps().find((step) => step.run?.includes(path));
    expect(reading?.run).toContain('$GITHUB_WORKSPACE/$CONFIG');
    const login = healthSteps().find((step) =>
      step.uses?.startsWith('hashicorp/vault-action@')
    );
    expect(login?.with?.['url']).toBe('${{ steps.fleet.outputs.vault }}');
  }
);

Then(
  "the CLI proxy health workflow runs the scripts of the {string} release the caller's package.json pins",
  (_world, name: string) => {
    const install = healthSteps().find((step) =>
      step.run?.includes('npm install')
    );
    expect(install?.run).toContain("require('./package.json')");
    expect(install?.run).toContain(`"${name}@$version"`);
    expect(install?.run).toContain('--ignore-scripts');
    const scripts = healthSteps().filter((step) =>
      /\.py"/.test(step.run ?? '')
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const step of scripts)
      expect(step.run).toContain('$CLIPROXY_SCRIPTS/');
  }
);

Then('the CLI proxy health workflow names no Vault address of its own', () => {
  expect(healthText()).not.toMatch(/https:\/\/vault\./);
});

Then(
  '{string} calls {string} in one {string} line',
  (_world, caller: string, workflow: string, key: string) => {
    const lines = readFileSync(
      resolve(import.meta.dir, '../..', caller),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.trim().startsWith(key));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`/${workflow}@`);
  }
);
