import { expect, test } from 'bun:test';
import { convergeProxy } from './proxy-converge';
import type { Runner } from './types';

const revision = 'a'.repeat(40);
function proxy(phases: object[]) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    return {
      ok: true,
      reason: 'exit',
      stderr: '',
      stdout: JSON.stringify({ version: 1, phases }),
    };
  };
  return { run, calls };
}

test('every sync applies; there is no separate maintenance mode', async () => {
  const plain = proxy([{ code: 'PROXY_CLIENT_ROLE', status: 'unchanged' }]);
  await convergeProxy('node', revision, plain.run);
  expect(plain.calls[0]).toContain('--apply');
  expect(plain.calls[0]).not.toContain('--maintenance');
});

test("the proxy's own remedy reaches the report", async () => {
  const { run } = proxy([
    {
      code: 'PROXY_UPDATE_PENDING',
      status: 'action-required',
      remedy: { action: 'Inspect bun run cliproxy install on the manager.' },
    },
    { code: 'PROXY_SOURCE_DRIFT', status: 'action-required', remedy: 7 },
  ]);
  const [pending, drift] = await convergeProxy('node', revision, run);
  expect(pending?.remedy?.action).toContain('cliproxy install');
  expect(drift?.remedy?.action).toContain('audit/recovery runbook');
});
