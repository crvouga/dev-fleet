import { expect } from 'bun:test';
import {
  accountPrefix,
  accountsFrom,
  discoverAccounts,
  type Account,
} from '../../../src/agents/accounts';
import {
  forward,
  pinModel,
  RETRY_DELAYS,
  startAccountRelay,
} from '../../../src/agents/account-relay';
import { pinAccount } from '../../../src/agents/launch';
import { select } from '../../../src/agents/registry';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type AgentsWorld } from './world';

export const accounts = steps<AgentsWorld>();
const { Given, When, Then } = accounts;

// ── The roster ───────────────────────────────────────────────────────────

const roster = part(() => ({
  models: [] as string[],
  answer: undefined as { status: number; body: unknown } | undefined,
  accounts: undefined as Account[] | undefined,
  prefix: undefined as string | undefined,
  relay: undefined as string | undefined,
  environment: {} as NodeJS.ProcessEnv,
}));

Given('the proxy lists these models:', (world, table: DataTable) => {
  roster(world).models = table.list();
});

Given('the proxy lists only the model {string}', (world, model: string) => {
  roster(world).models = [model];
});

Given(
  'the proxy answers a request for its models with the status {int} and no list',
  (world, status: number) => {
    roster(world).answer = { status, body: {} };
  }
);

When('the roster is read from the model list', (world) => {
  roster(world).accounts = accountsFrom(roster(world).models);
});

When(
  'the roster is asked of the proxy with the key {string}',
  async (world, key: string) => {
    const state = roster(world);
    const { status, body } = state.answer ?? {
      status: 200,
      body: { data: state.models.map((id) => ({ id })) },
    };
    const send = (async () =>
      Response.json(body, { status })) as unknown as typeof fetch;
    await world.attempt(async () => {
      state.accounts = await discoverAccounts(key, send);
    });
  }
);

Then('the roster is:', (world, table: DataTable) => {
  const rows = table.hashes() as {
    tool: string;
    email: string;
    prefix: string;
    models: string;
  }[];
  expect(roster(world).accounts).toEqual(
    rows.map((row) => ({ ...row, models: row.models.split(', ') }))
  );
});

Then('the roster is empty', (world) => {
  expect(roster(world).accounts).toEqual([]);
});

Then('the roster has {int} accounts', (world, count: number) => {
  expect(world.refusal).toBeUndefined();
  expect(roster(world).accounts).toHaveLength(count);
});

When(
  'the prefix of the {string} account {string} is asked for',
  async (world, tool: string, email: string) => {
    await world.attempt(() => {
      roster(world).prefix = accountPrefix(tool, email);
    });
  }
);

Then('the prefix is {string}', (world, prefix: string) => {
  expect(roster(world).prefix).toBe(prefix);
});

// ── Pinning a launch to an account ───────────────────────────────────────

Given('a relay that listens at {string}', (world, url: string) => {
  roster(world).relay = url;
});

Given(
  'the environment sets {string} to {string}',
  (world, name: string, value: string) => {
    roster(world).environment[name] = value;
  }
);

When(
  '{string} is launched on the machine {string} for the account {string}, with its profile in {string}',
  async (
    world,
    tool: string,
    machine: string,
    account: string,
    directory: string
  ) => {
    const state = roster(world);
    const relay = () => {
      if (!state.relay) throw new Error('This launch was given no relay.');
      return { url: state.relay, stop: () => {} };
    };
    await world.attempt(() =>
      pinAccount(
        state.environment,
        select(machine, tool, 'proxy'),
        { account, directory },
        { relay, discover: async () => accountsFrom(state.models) }
      )
    );
  }
);

Then(
  'its environment sets {string} to {string}',
  (world, name: string, value: string) => {
    expect(world.refusal).toBeUndefined();
    expect(roster(world).environment[name]).toBe(value);
  }
);

Then('its environment no longer sets {string}', (world, name: string) => {
  expect(world.refusal).toBeUndefined();
  expect(roster(world).environment[name]).toBeUndefined();
});

interface OpenCodeConfig {
  enabled_providers: string[];
  provider: Record<string, { models: Record<string, unknown> }>;
}
const openCode = (world: AgentsWorld): OpenCodeConfig =>
  JSON.parse(
    roster(world).environment['OPENCODE_CONFIG_CONTENT']!
  ) as OpenCodeConfig;

Then(
  'its OpenCode configuration enables only the provider {string}',
  (world, provider: string) => {
    expect(openCode(world).enabled_providers).toEqual([provider]);
  }
);

Then(
  'its OpenCode configuration offers exactly these models from {string}:',
  (world, provider: string, table: DataTable) => {
    expect(Object.keys(openCode(world).provider[provider]!.models)).toEqual(
      table.list()
    );
  }
);

// ── The relay ────────────────────────────────────────────────────────────

interface Seen {
  url: string;
  body: string;
  authorization: string | null;
}
const relay = part(() => ({
  endpoint: '',
  respond: undefined as (() => Response) | undefined,
  seen: [] as Seen[],
  waits: [] as number[],
  pinned: undefined as string | undefined,
  response: undefined as Response | undefined,
  text: undefined as string | undefined,
  echo: undefined as unknown,
  url: undefined as string | undefined,
  origin: undefined as string | undefined,
}));

When(
  /^the request body (.+) is pinned to the account prefix "([^"]*)"$/,
  (world, body: string, prefix: string) => {
    relay(world).pinned = pinModel(body, prefix);
  }
);

Then(/^the body sent on is (.+)$/, (world, body: string) => {
  expect(relay(world).pinned).toBe(body);
});

// A server-sent event ends with an empty line.
const event = (text: string): string => `${text}\n\n`;

Given(
  /^the proxy at "([^"]*)" streams the event "([^"]*)"(?: with these headers:)?$/,
  (world, endpoint: string, text: string, table?: DataTable) => {
    const state = relay(world);
    state.endpoint = endpoint;
    state.respond = () =>
      new Response(event(text), { headers: table?.rowsHash() ?? {} });
  }
);

Given(
  'the proxy at {string} answers in turn:',
  (world, endpoint: string, table: DataTable) => {
    const state = relay(world);
    const answers = table.hashes() as { status: string; body: string }[];
    state.endpoint = endpoint;
    state.respond = () => {
      const next = answers.shift();
      if (!next) throw new Error('The proxy has no further answer.');
      return new Response(next.body, { status: Number(next.status) });
    };
  }
);

Given(
  'the proxy at {string} always answers with the status {int} and the body {string}',
  (world, endpoint: string, status: number, body: string) => {
    const state = relay(world);
    state.endpoint = endpoint;
    state.respond = () => new Response(body, { status });
  }
);

When(
  /^an agent pinned to "([^"]*)" posts (.+) to "([^"]*)"(?: with these headers:)?$/,
  async (
    world,
    prefix: string,
    body: string,
    path: string,
    table?: DataTable
  ) => {
    const state = relay(world);
    const send = (async (url: string, init: RequestInit) => {
      state.seen.push({
        url,
        body: String(init.body),
        authorization: new Headers(init.headers).get('authorization'),
      });
      return state.respond!();
    }) as unknown as typeof fetch;
    state.response = await forward(
      new Request(`http://127.0.0.1:1${path}`, {
        method: 'POST',
        headers: table?.rowsHash() ?? {},
        body,
      }),
      state.endpoint,
      prefix,
      { send, pause: async (seconds) => void state.waits.push(seconds) }
    );
  }
);

const answered = async (world: AgentsWorld): Promise<string> => {
  const state = relay(world);
  return (state.text ??= await state.response!.text());
};

Then('the proxy received exactly this request:', (world, table: DataTable) => {
  const { url, body, authorization } = table.rowsHash();
  expect(relay(world).seen).toEqual([
    { url: url!, body: body!, authorization: authorization! },
  ]);
});

Then('the proxy received no request', (world) => {
  expect(relay(world).seen).toHaveLength(0);
});

Then('the agent receives the event {string}', async (world, text: string) => {
  expect(await answered(world)).toBe(event(text));
});

Then('the agent receives the status {int}', (world, status: number) => {
  expect(relay(world).response!.status).toBe(status);
});

Then('the agent receives the body {string}', async (world, body: string) => {
  expect(await answered(world)).toBe(body);
});

Then('the answer carries no {string} header', (world, name: string) => {
  expect(relay(world).response!.headers.get(name)).toBeNull();
});

Then(
  /^the relay waited for ([\d, ]+) seconds? in turn$/,
  (world, seconds: string) => {
    expect(relay(world).waits).toEqual(seconds.split(', ').map(Number));
  }
);

Then('the relay never waited', (world) => {
  expect(relay(world).waits).toEqual([]);
});

Then(/^every attempt carried the body (.+)$/, (world, body: string) => {
  expect(new Set(relay(world).seen.map((request) => request.body))).toEqual(
    new Set([body])
  );
});

Then(
  'the proxy was asked {int} times, once more than the relay has retry delays',
  (world, count: number) => {
    expect(relay(world).seen).toHaveLength(count);
    expect(count).toBe(RETRY_DELAYS.length + 1);
  }
);

// ── A running relay ──────────────────────────────────────────────────────

Given(
  'a proxy on the loopback interface that answers with the path and body it was sent',
  (world) => {
    const origin = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) =>
        Response.json({
          got: await request.json(),
          path: new URL(request.url).pathname,
        }),
    });
    world.defer(() => void origin.stop(true));
    relay(world).origin = `http://127.0.0.1:${origin.port}`;
  }
);

Given(
  'a relay running for the account prefix {string}',
  (world, prefix: string) => {
    const running = startAccountRelay(relay(world).origin!, prefix);
    world.defer(() => running.stop());
    relay(world).url = running.url;
  }
);

When(
  /^an agent posts (.+) to "([^"]*)" on the relay$/,
  async (world, body: string, path: string) => {
    const response = await fetch(`${relay(world).url!}${path}`, {
      method: 'POST',
      body,
    });
    relay(world).echo = await response.json();
  }
);

Then(
  'the proxy was sent the path {string} and the body:',
  (world, path: string, body: string) => {
    expect(relay(world).echo).toEqual({ got: JSON.parse(body), path });
  }
);
