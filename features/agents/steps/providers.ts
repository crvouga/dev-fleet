import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferenceFailure } from '../../../src/agents/fleet-verify';
import {
  providerFailureCode,
  providerHttpFailure,
} from '../../../src/agents/provider-errors';
import { select } from '../../../src/agents/registry';
import { verifyRoundTrip } from '../../../src/agents/round-trip';
import { inferenceRequest } from '../../../src/agents/verify';
import {
  VERIFY_MAX_AGE_MS,
  cachedCheck,
} from '../../../src/agents/verify-cache';
import type { Check } from '../../../src/types';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type AgentsWorld } from './world';

export const providers = steps<AgentsWorld>();
const { Given, When, Then } = providers;

// ── Failure codes ────────────────────────────────────────────────────────

const failure = part(() => ({
  code: undefined as string | undefined,
  check: undefined as Check | undefined,
}));

When(
  'the gateway rejects a verification request with the status {int}',
  (world, status: number) => {
    failure(world).code = providerFailureCode(providerHttpFailure(status));
  }
);

When(
  /^a verification request fails with an? (Error|TypeError) that says "([^"]*)"$/,
  (world, kind: string, message: string) => {
    failure(world).code = providerFailureCode(
      kind === 'TypeError' ? new TypeError(message) : new Error(message)
    );
  }
);

Then('the failure is reported as {string}', (world, code: string) => {
  expect(failure(world).code).toBe(code);
});

When(
  'the inference check of {string} fails with {string}',
  (world, provider: string, code: string) => {
    failure(world).check = inferenceFailure(provider, code);
  }
);

Then('the check has the status {string}', (world, status: string) => {
  expect(failure(world).check!.status).toBe(status as Check['status']);
});

// ── Inference requests ───────────────────────────────────────────────────

const inference = part(() => ({
  request: undefined as ReturnType<typeof inferenceRequest> | undefined,
}));

When(
  'the inference request of {string} on the machine {string} through the proxy is built',
  (world, tool: string, machine: string) => {
    inference(world).request = inferenceRequest(select(machine, tool, 'proxy'));
  }
);

Then('it is sent to {string}', (world, path: string) => {
  expect(inference(world).request!.path).toBe(path);
});

Then('its body is:', (world, body: string) => {
  expect(inference(world).request!.body).toEqual(JSON.parse(body));
});

// ── The round trip ───────────────────────────────────────────────────────

interface Sent {
  redirect: RequestInit['redirect'];
  body: {
    stream?: boolean;
    tool_choice?: unknown;
    input: unknown[];
    tools: { parameters: { properties: { nonce: { enum: string[] } } } }[];
  };
}
const trip = part(() => ({
  events: [] as string[],
  call: undefined as { name: string; id: string } | undefined,
  replies: false,
  sent: [] as Sent[],
}));
const offered = (request: Sent): string =>
  request.body.tools[0]!.parameters.properties.nonce.enum[0]!;

Given('a provider that streams these events:', (world, table: DataTable) => {
  trip(world).events = table.list();
});

Given(
  'the provider answers a tool request by calling {string} as the call {string}, with the nonce it was offered',
  (world, name: string, id: string) => {
    trip(world).call = { name, id };
  }
);

Given('the provider then replies with the result of the call', (world) => {
  trip(world).replies = true;
});

When(
  'the provider is verified with the model {string} and the key {string}',
  async (world, model: string, key: string) => {
    const state = trip(world);
    const refused = new Response('The scenario describes no such answer.', {
      status: 500,
    });
    const request = (async (_url: unknown, options: RequestInit = {}) => {
      const sent: Sent = {
        redirect: options.redirect,
        body: JSON.parse(String(options.body)) as Sent['body'],
      };
      state.sent.push(sent);
      if (sent.body.stream)
        return new Response(
          state.events.map((event) => `data: ${event}\n\n`).join('')
        );
      const nonce = offered(sent);
      if (sent.body.tool_choice !== 'none')
        return state.call
          ? Response.json({
              output: [
                {
                  type: 'function_call',
                  name: state.call.name,
                  call_id: state.call.id,
                  arguments: JSON.stringify({ nonce }),
                },
              ],
            })
          : refused;
      return state.replies
        ? Response.json({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: nonce }],
              },
            ],
          })
        : refused;
    }) as typeof fetch;
    await world.attempt(() => verifyRoundTrip(model, key, request));
  }
);

Then('the provider is verified', (world) => {
  expect(world.refusal).toBeUndefined();
});

Then('verification fails with {string}', (world, code: string) => {
  expect(world.refusal?.message).toContain(code);
});

Then(/^(\d+) requests? (?:was|were) sent$/, (world, count: number) => {
  expect(trip(world).sent).toHaveLength(Number(count));
});

Then('every request refuses to follow a redirect', (world) => {
  expect(trip(world).sent.length).toBeGreaterThan(0);
  for (const request of trip(world).sent)
    expect(request.redirect).toBe('error');
});

Then(
  'the last request returns the nonce as the output of the call {string}',
  (world, id: string) => {
    const last = trip(world).sent.at(-1)!;
    expect(last.body.input[2]).toEqual({
      type: 'function_call_output',
      call_id: id,
      output: offered(last),
    });
  }
);

Then('no request contains {string}', (world, text: string) => {
  expect(
    JSON.stringify(trip(world).sent.map((request) => request.body))
  ).not.toContain(text);
});

// ── Remembered verification ──────────────────────────────────────────────

const remembered = part(() => ({
  directory: undefined as string | undefined,
  name: '',
  outcome: 'passed',
  reusable: true,
  runs: 0,
  result: undefined as Check | undefined,
}));

/** A new directory for the scenario: never the machine's own. */
async function directory(world: AgentsWorld): Promise<string> {
  const state = remembered(world);
  if (!state.directory) {
    const created = await mkdtemp(join(tmpdir(), 'verify-cache-'));
    world.defer(() => rm(created, { recursive: true, force: true }));
    state.directory = created;
  }
  return state.directory;
}

async function verify(
  world: AgentsWorld,
  key: string,
  now: number,
  bypass = false
): Promise<void> {
  const state = remembered(world);
  state.result = await cachedCheck(
    state.name,
    key,
    async () => {
      state.runs++;
      return state.outcome === 'passed'
        ? { id: 'provider:x:inference', status: 'pass', summary: 'ok' }
        : { id: 'provider:x:inference', status: 'fail', summary: 'BAD' };
    },
    {
      directory: await directory(world),
      now,
      ...(bypass ? { bypass } : {}),
      ...(state.reusable ? {} : { reuse: () => false }),
    }
  );
}

Given(
  'a verified pass is remembered for {int} hours',
  (_world, hours: number) => {
    expect(VERIFY_MAX_AGE_MS).toBe(hours * 60 * 60 * 1000);
  }
);

Given(
  /^the check "([^"]*)" (passed|failed) with the key "([^"]*)" at (\d+) ms(, as a pass that must not be reused)?$/,
  async (
    world,
    name: string,
    outcome: string,
    key: string,
    now: number,
    single?: string
  ) => {
    Object.assign(remembered(world), { name, outcome, reusable: !single });
    await verify(world, key, Number(now));
  }
);

When(
  /^it is verified again with the key "([^"]*)" at (\d+) ms(, ignoring what is remembered)?$/,
  async (world, key: string, now: number, bypass?: string) => {
    await verify(world, key, Number(now), Boolean(bypass));
  }
);

Then(/^it has been verified (\d+) times? in all$/, (world, count: number) => {
  expect(remembered(world).runs).toBe(Number(count));
});

Then('the result passes', (world) => {
  expect(remembered(world).result!.status).toBe('pass');
});

Then('the summary of the result contains {string}', (world, text: string) => {
  expect(remembered(world).result!.summary).toContain(text);
});
