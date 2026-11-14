import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import {
  bucketStore,
  fleetWatch,
  type WatchStore,
} from '../../../src/cli/fleet-watch';
import { parseNotify, type NotifyConfig } from '../../../src/notify';
import type { SecretName } from '../../../src/secrets';
import type { Check, NodeReport } from '../../../src/types';
import { cli, outcome, part, temporary, type CliWorld } from './world';

/** fleet-watch against a webhook and an ntfy receiver on this machine. The
 * fleet's health is what the scenario says fleet-status sees; the watcher's
 * memory lives in a directory that stands in for the bucket.
 */
const { Given, When, Then } = cli;

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}

const watch = part(() => ({
  notify: undefined as NotifyConfig | undefined,
  secrets: {} as Partial<Record<SecretName, string>>,
  received: [] as Received[],
  answer: 200,
  store: undefined as WatchStore | null | undefined,
  nodes: [] as NodeReport[],
}));

function nodes(failing: Record<string, string>): NodeReport[] {
  return Object.entries(failing).map(([node, ids]) => ({
    node,
    checks: [
      { id: 'worker:ubuntu', status: 'pass', summary: 'fine' },
      ...ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id): Check => ({
          id,
          status: 'fail',
          summary: `PRIVATE raw summary of ${id}`,
        })),
    ],
  }));
}

Given(
  /^an? (webhook|ntfy) receiver on this machine(?:, answering (\d+))?$/,
  (world, kind: string, answer: string | undefined) => {
    const state = watch(world);
    if (answer) state.answer = Number(answer);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        state.received.push({
          path: new URL(request.url).pathname,
          headers: Object.fromEntries(
            request.headers as unknown as [string, string][]
          ),
          body: await request.text(),
        });
        return new Response('PRIVATE receiver answer', {
          status: state.answer,
        });
      },
    });
    world.defer(() => server.stop(true));
    state.secrets[kind === 'ntfy' ? 'notify-ntfy-url' : 'notify-webhook-url'] =
      `http://127.0.0.1:${server.port}/${kind}/PRIVATE-TOKEN`;
  }
);

Given('the fleet configuration says:', (world, json: string) => {
  const notify = parseNotify((JSON.parse(json) as { notify: unknown }).notify);
  if (!notify) throw new Error('The notify block is invalid.');
  watch(world).notify = notify;
});

Given('the fleet configuration has no notify block', (world) => {
  watch(world).notify = undefined;
});

Given('the bucket is a directory', async (world) => {
  watch(world).store = bucketStore({
    kind: 'directory',
    path: await temporary(world, 'watch-bucket-'),
  });
});

Given('fleet-status sees every worker ready', (world) => {
  watch(world).nodes = nodes({ 'worker-a': '', 'worker-b': '' });
});

async function run(world: CliWorld, test: boolean, at: string) {
  const state = watch(world);
  world.outcome = await fleetWatch(test ? { test } : {}, {
    notify: state.notify,
    status: () => Promise.resolve(state.nodes),
    store: state.store ?? null,
    secrets: (name) => Promise.resolve(state.secrets[name] ?? null),
    send: fetch,
    now: () => new Date(at),
  });
}

When('the watcher runs', async (world) => {
  await run(world, false, '2026-11-11T00:00:00Z');
});

When('the watcher sends a test notification', async (world) => {
  await run(world, true, '2026-11-11T00:00:00Z');
});

When(
  'the watcher runs at these times, while fleet-status sees these failing checks:',
  async (world, table: DataTable) => {
    for (const row of table.hashes()) {
      const { time, ...failing } = row;
      watch(world).nodes = nodes(failing);
      await run(world, false, time!);
    }
  }
);

Then(/^the receiver got (\d+) notifications?$/, (world, count: string) => {
  expect(watch(world).received).toHaveLength(Number(count));
});

Then('the webhook receiver got, in order:', (world, table: DataTable) => {
  expect(
    watch(world).received.map((entry) => {
      const body = JSON.parse(entry.body) as {
        event: string;
        node: string;
        checks: string[];
      };
      return {
        event: body.event,
        node: body.node,
        checks: body.checks.join(', '),
      };
    })
  ).toEqual(
    table.hashes() as { event: string; node: string; checks: string }[]
  );
});

Then('the ntfy receiver got the text {string}', (world, text: string) => {
  expect(watch(world).received.map((entry) => entry.body)).toEqual([text]);
});

Then('nothing the receiver got contains {string}', (world, text: string) => {
  for (const entry of watch(world).received)
    // The address itself is the secret the receiver was reached at.
    expect(entry.body + JSON.stringify(entry.headers)).not.toContain(text);
});

Then(
  'nothing fleet-watch reported contains {string}',
  (world, text: string) => {
    expect(JSON.stringify(outcome(world).data)).not.toContain(text);
    expect(outcome(world).text ?? '').not.toContain(text);
  }
);

Then(
  /^fleet-watch exits with (\d+) and its check "([^"]+)" (passes|fails|warns)$/,
  (world, code: string, id: string, verdict: string) => {
    const result = outcome(world);
    expect(result.exitCode).toBe(Number(code));
    const checks = (result.data as { checks: Check[] }).checks;
    expect(checks.find((check) => check.id === id)?.status).toBe(
      ({ passes: 'pass', fails: 'fail', warns: 'warn' } as const)[
        verdict as 'passes'
      ]
    );
  }
);

Then(
  'the bucket holds a heartbeat from {string}',
  async (world, at: string) => {
    const text = await watch(world).store!.read();
    expect((JSON.parse(text!) as { heartbeatAt: string }).heartbeatAt).toBe(
      new Date(at).toISOString()
    );
  }
);

Then('the notify block {string} is refused', (_world, json: string) => {
  expect(parseNotify(JSON.parse(json))).toBeNull();
});

Given(
  'fleet-status warns about {string} on {string}',
  (world, id: string, node: string) => {
    watch(world).nodes = [
      { node, checks: [{ id, status: 'warn', summary: 'low disk' }] },
    ];
  }
);
