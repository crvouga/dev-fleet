import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dir, '..');
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8');

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  services?: Record<string, { image: string }>;
  steps: Step[];
}
const ci = parse(read('.github/workflows/ci.yml')) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

// CI checks a pull request with the tools every machine gets, not with
// whatever an action picks that day.
test('CI installs the mise version bootstrap installs', () => {
  const pinned = /^MISE_VERSION=(\S+)$/m.exec(read('bootstrap/bootstrap.sh'));
  expect(pinned).not.toBeNull();
  const steps = Object.values(ci.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith('jdx/mise-action@'));
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    expect(step.with?.['version']).toBe(pinned![1]!);
    // Named tools only: never the whole workstation toolchain.
    expect(step.with?.['install_args']).toBeString();
  }
});

test('every service image a check starts is pinned by digest', () => {
  const images = Object.values(ci.jobs).flatMap((job) =>
    Object.values(job.services ?? {}).map((service) => service.image)
  );
  expect(images.length).toBeGreaterThan(0);
  for (const image of images)
    expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
});

test('the fleet state check runs on every pull request and cannot skip its tests', () => {
  expect(Object.keys(ci.on)).toContain('pull_request');
  const state = ci.jobs['state']!;
  expect(state.if).toBeUndefined();
  const env = Object.assign({}, ...state.steps.map((step) => step.env ?? {}));
  expect(env).toMatchObject({
    DEVFLEET_TEST_LITESTREAM: 'required',
    DEVFLEET_TEST_S3: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
  });
});
