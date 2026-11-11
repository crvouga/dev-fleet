import { expect, test } from 'bun:test';
import { execute } from '../../src/cli/program';
import { capabilities } from '../../src/cli/options';
import { CAPABILITIES } from '../../src/config';

const settings = { workspace: '/missing-workspace', config: '/missing-roster' };
test('the sole public parser preserves fleet defaults and preview authorization', async () => {
  expect(capabilities('none')).toEqual([]);
  expect(capabilities()).toEqual(
    CAPABILITIES.filter((entry) => entry !== 'worker')
  );
  expect((await execute([], settings, 'test')).exitCode).toBe(0);
});
test.each(
  [
    ['fleet-repair', '--apply'],
    ['fleet-status', '--apply', '--yes'],
    ['fleet-status', '--pull'],
    ['fleet-status', '--local', '--node', 'dev-one'],
    ['fleet-status', '--timeout', 'Infinity'],
    ['fleet-status', '--timeout', '0'],
    ['fleet-status', '--require', 'made-up'],
    ['fleet-status', '--tailnet', '--require', 'none'],
    ['fleet-discover', '--local'],
    ['fleet-unknown'],
    ['fleet', 'doctor'],
  ].map((args) => ({ args }))
)('the public fleet parser rejects unsafe options %j', async ({ args }) => {
  expect((await execute([...args, '--json'], settings, 'test')).exitCode).toBe(
    2
  );
});
