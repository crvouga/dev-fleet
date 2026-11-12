import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { World, steps, type DataTable } from '../support/gherkin';
import { Commands, failed, succeeded } from '../support/commands';
import { accountsFrom } from '../../src/agents/accounts';
import { forward, RETRY_DELAYS } from '../../src/agents/account-relay';
import { routeThroughRelay } from '../../src/agents/launch';
import { select } from '../../src/agents/registry';
import { cacheKey, cachedCheck } from '../../src/agents/verify-cache';
import {
  nativeLoginCheck,
  nativeLogins,
  providerAccountChecks,
  proxyReachableCheck,
  rosterCurrentCheck,
} from '../../src/accounts/checks';
import { exposedVersion } from '../../src/accounts/context';
import { propagateAccounts } from '../../src/accounts/propagate';
import {
  liveVersion,
  rosterVersion,
  type ProxyRoster,
  type RosterAccount,
} from '../../src/accounts/roster';
import { AccountSelector } from '../../src/accounts/selection';
import {
  accountSessionChecks,
  sessionResult,
  type Instance,
  type SessionResult,
} from '../../src/accounts/sessions';
import { fleetAccounts } from '../../src/cli/fleet-accounts';
import type { CommandOutcome } from '../../src/cli/contracts';
import type { Check, FleetNode } from '../../src/types';

/** 2027-01-15T08:00:00Z */
const NOW = 1_800_000_000_000;
const REPOSITORY = resolve(import.meta.dir, '../..');
const REVISION = 'a'.repeat(40);

export class AccountsWorld extends World {
  roster?: ProxyRoster;
  minimum?: number;
  checks: Check[] = [];
  models: string[] = [];
  versions: string[] = [];
  exposed: Instance[] = [];
  home?: string;
  // The lifecycle
  commands = new Commands();
  operated: string[][] = [];
  operateExit = 0;
  propagated = 0;
  outcome?: CommandOutcome;
  refusal?: Error;
  // Propagation
  nodes: FleetNode[] = [];
  managerApplied = false;
  reports: { node: string; checks: Check[] }[] = [];
  // Relay and selection
  selector?: AccountSelector;
  candidates: string[] = [];
  sent: string[] = [];
  waits: number[] = [];
  responses: Response[] = [];
  respond: (model: string) => Response | Promise<Response> = () =>
    new Response('ok');
  relayEnv: NodeJS.ProcessEnv = {};
  relayed?: { args: string[] } | null;
  // Sessions
  sessions: Record<string, SessionResult> = {};
  sessionsRun: string[] = [];
  result?: SessionResult;
  cache?: string;
  computed = 0;

  temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), 'devfleet-accounts-'));
    this.defer(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
  }
}

export const accounts = steps<AccountsWorld>();
const { Given, When, Then } = accounts;

// ── Account state ────────────────────────────────────────────────────────

Given('the proxy reports these accounts:', (world, table: DataTable) => {
  const list: RosterAccount[] = table.hashes().map((row) => ({
    provider: row['provider']!,
    index: Number(row['index']),
    label: row['label']!,
    prefix: `${row['provider']}-${row['label']}`,
    state: row['state'] as RosterAccount['state'],
    until: row['until'] || null,
  }));
  world.roster = {
    version: 1,
    rosterVersion: rosterVersion(
      list.filter((a) => a.state !== 'removed').map((a) => a.prefix!)
    ),
    managementApi: true,
    accounts: list,
  };
});

Given(
  'the fleet wants {int} usable accounts of every provider',
  (world, minimum: number) => {
    world.minimum = minimum;
  }
);

When('the account checks are made', (world) => {
  world.checks = providerAccountChecks(world.roster!, world.minimum);
});

const VERDICT: Record<string, Check['status']> = {
  passes: 'pass',
  fails: 'fail',
  warns: 'warn',
  passing: 'pass',
};

function named(world: AccountsWorld, id: string): Check {
  const found = world.checks.filter((check) => check.id === id);
  expect(found.map((check) => check.id)).toEqual([id]);
  return found[0]!;
}

Then(
  /^the check "([^"]+)" (passes|fails|warns)(?: saying "(.*)")?$/,
  (world, id: string, verdict: string, saying?: string) => {
    const check = named(world, id);
    expect(check.status).toBe(VERDICT[verdict]!);
    if (saying) expect(check.summary).toContain(saying);
  }
);

Then(
  'the check {string} asks to run {string}',
  (world, id: string, command: string) => {
    expect(named(world, id).remedy?.command).toBe(command);
  }
);

Then('it asks to run {string}', (world, command: string) => {
  expect(world.checks.map((check) => check.remedy?.command)).toContain(command);
});

Then('no check names {string}', (world, text: string) => {
  expect(world.checks.length).toBeGreaterThan(0);
  expect(JSON.stringify(world.checks)).not.toContain(text);
});

Then('there is no check {string}', (world, id: string) => {
  expect(world.checks.map((check) => check.id)).not.toContain(id);
});

// ── The roster ───────────────────────────────────────────────────────────

Given('the proxy lists these models:', (world, table: DataTable) => {
  world.models = table.list();
});

Given('the proxy now also lists {string}', (world, model: string) => {
  world.models.push(model);
});

When('the roster version is computed from the model list', (world) => {
  world.versions.push(liveVersion(accountsFrom(world.models)));
});

Then('the roster version is {string}', (world, version: string) => {
  expect(world.versions.at(-1)).toBe(version);
});

Then('the roster version has changed', (world) => {
  expect(world.versions).toHaveLength(2);
  expect(world.versions[1]).not.toBe(world.versions[0]);
});

Given(
  'this node offers these account instances:',
  (world, table: DataTable) => {
    world.exposed = table.hashes().map((row) => ({
      tool: row['tool']!,
      account: row['account']!,
    }));
  }
);

When("this node's roster is checked", (world) => {
  world.checks = [
    rosterCurrentCheck(
      liveVersion(accountsFrom(world.models)),
      exposedVersion(world.exposed)
    ),
  ];
});

Given('a home where these files exist:', (world, table: DataTable) => {
  const home = (world.home = world.temporary());
  for (const path of table.list()) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), '{}');
  }
});

When('the node is checked for provider logins of its own', (world) => {
  world.checks = [nativeLoginCheck(nativeLogins(world.home!))];
});

// ── The lifecycle ────────────────────────────────────────────────────────

Given("the proxy's sign-in is interrupted", (world) => {
  world.operateExit = 1;
});

When(
  'the operator runs fleet-accounts with {string}',
  async (world, line: string) => {
    const words = line.split(' ').filter(Boolean);
    const options = Object.fromEntries(
      words
        .filter((word) => word.startsWith('--'))
        .map((word) => [
          word.slice(2).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
          true,
        ])
    );
    const args = words.filter((word) => !word.startsWith('--'));
    world.commands.answer(
      'accounts --json',
      succeeded(JSON.stringify(world.roster))
    );
    try {
      world.outcome = await fleetAccounts(
        options,
        args,
        { workspace: REPOSITORY, config: 'state:roster' },
        {
          run: world.commands.run,
          operate: async (forwarded) => {
            world.operated.push(forwarded);
            return world.operateExit;
          },
          propagate: async () => {
            world.propagated++;
            return { exitCode: 0, data: { version: 1, ok: true } };
          },
          home: world.temporary(),
          settingsFile: join(world.temporary(), 'settings.json'),
        }
      );
      world.checks = (world.outcome.data as { checks?: Check[] }).checks ?? [];
    } catch (error) {
      world.refusal = error as Error;
    }
  }
);

Then('it exits with {int}', (world, code: number) => {
  expect(world.refusal).toBeUndefined();
  expect(world.outcome?.exitCode).toBe(code);
});

Then(
  /^it lists (\w+) account (\d+) as "(.*)"$/,
  (world, provider: string, index: string, state: string) => {
    const listed = (
      world.outcome!.data as { accounts: RosterAccount[] }
    ).accounts.find(
      (account) =>
        account.provider === provider && account.index === Number(index)
    );
    expect(listed?.state).toBe(state as RosterAccount['state']);
  }
);

Then('the proxy was asked for nothing but its roster', (world) => {
  expect(world.operated).toEqual([]);
  expect(world.commands.calls.length).toBeGreaterThan(0);
  for (const call of world.commands.calls)
    expect(call.command.slice(-2)).toEqual(['accounts', '--json']);
});

Then('the proxy ran {string}', (world, command: string) => {
  expect(world.operated).toEqual([command.split(' ')]);
});

Then('the proxy ran nothing', (world) => {
  expect(world.operated).toEqual([]);
});

Then('the accounts were propagated once', (world) => {
  expect(world.propagated).toBe(1);
});

Then('the accounts were not propagated', (world) => {
  expect(world.propagated).toBe(0);
});

Then('it is refused saying {string}', (world, message: string) => {
  expect(world.refusal?.message).toContain(message);
});

// ── Propagation ──────────────────────────────────────────────────────────

Given(
  'the enrolled workers {string} and {string} at the approved revision',
  (world, ...ids: string[]) => {
    world.nodes = ids.map((id) => ({
      id,
      ssh: id,
      workspace: `/home/dev/${id}`,
      required: ['worker'],
    }));
    world.commands.answer(
      (command) => command[0] === 'ssh' && command.at(-1) === 'true',
      succeeded()
    );
    world.commands.answer(
      'personal/fleet/revisions',
      succeeded(`/home/dev/.local/share/personal/fleet/revisions/${REVISION}`)
    );
  }
);

const applied = {
  version: 1,
  checks: [
    {
      id: 't3:providers',
      status: 'pass',
      summary: 'T3 offers the account instances.',
    },
  ],
};

Given('every worker applies its accounts', (world) => {
  world.commands.answer(
    '--input-type=module',
    succeeded(JSON.stringify(applied))
  );
});

Given('{string} cannot be reached', (world, id: string) => {
  world.commands.answer(
    (command) => command[0] === 'ssh' && command.includes(id),
    { ...failed('ssh: connect to host: Connection timed out'), reason: 'exit' }
  );
});

When('the accounts are propagated', async (world) => {
  world.outcome = await propagateAccounts({
    nodes: world.nodes,
    revision: REVISION,
    source: '// the bundled remote entry',
    manager: async () => {
      world.managerApplied = true;
      return [{ id: 't3:providers', status: 'pass', summary: 'Applied.' }];
    },
    run: world.commands.run,
  });
  world.reports = (
    world.outcome.data as { nodes: { node: string; checks: Check[] }[] }
  ).nodes;
});

/** The request a remote command carries, decoded. */
function requestOf(command: string[]): { action?: string } {
  const encoded = /'([A-Za-z0-9+/=]+)'$/.exec(command.at(-1)!)?.[1] ?? '';
  return JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
    action?: string;
  };
}

Then(
  'each worker was sent exactly one request, for the action {string}',
  (world, action: string) => {
    for (const node of world.nodes) {
      const sent = world.commands
        .ran('--input-type=module')
        .filter((command) => command.includes(node.ssh));
      expect(sent).toHaveLength(1);
      expect(requestOf(sent[0]!).action).toBe(action);
    }
  }
);

Then('the manager applied its own accounts', (world) => {
  expect(world.managerApplied).toBe(true);
});

Then(
  '{string} reports the check {string} passing',
  (world, node: string, id: string) => {
    const report = world.reports.find((entry) => entry.node === node);
    expect(report?.checks.find((check) => check.id === id)?.status).toBe(
      'pass'
    );
  }
);

Then('{string} reports a failed SSH check', (world, node: string) => {
  const report = world.reports.find((entry) => entry.node === node);
  expect(
    report?.checks.some(
      (check) => check.id.startsWith('ssh:') && check.status === 'fail'
    )
  ).toBe(true);
});

// ── Selection and the relay ──────────────────────────────────────────────

Given('the accounts {string}', (world, list: string) => {
  world.candidates = list.split(', ');
});

Given(
  'the policy {string} naming first {string}',
  (world, strategy: string, named: string) => {
    world.selector = new AccountSelector(
      world.candidates,
      {
        strategy: strategy as 'fill-first',
        ...(named ? { order: [named] } : {}),
      },
      () => NOW
    );
  }
);

When(/^(\d+) requests choose their accounts$/, (world, count: string) => {
  for (let turn = 0; turn < Number(count); turn++)
    world.candidates = world.selector!.candidates();
});

Then('the last request tries {string}', (world, order: string) => {
  expect(world.candidates.join(', ')).toBe(order);
});

Then('the next request tries only {string}', (world, prefix: string) => {
  expect(world.selector!.candidates()).toEqual([prefix]);
});

Given(
  'the proxy answers {int} for {string} and {int} for every other account',
  (world, refused: number, prefix: string, served: number) => {
    world.respond = (model) =>
      model.startsWith(`${prefix}/`)
        ? new Response('limited', { status: refused })
        : new Response('ok', { status: served });
  }
);

Given('the proxy never answers', (world) => {
  world.respond = () => {
    throw new TypeError('connection refused');
  };
});

async function post(
  world: AccountsWorld,
  body: string,
  prefix = '',
  alternatives?: string[]
): Promise<void> {
  const send = (async (_url: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    world.sent.push(model);
    return world.respond(model);
  }) as unknown as typeof fetch;
  world.responses.push(
    await forward(
      new Request('http://127.0.0.1:1/v1/responses', { method: 'POST', body }),
      'https://proxy.example',
      prefix,
      {
        send,
        pause: async (seconds) => void world.waits.push(seconds),
        now: () => NOW,
        ...(world.selector ? { selector: world.selector } : {}),
        ...(alternatives ? { alternatives } : {}),
      }
    )
  );
}

When(/^an unpinned agent (?:posts|has posted) (.+)$/, (world, body: string) =>
  post(world, body)
);

When(
  /^an agent pinned to "([^"]+)" with the alternative "([^"]+)" posts (.+) twice$/,
  async (world, prefix: string, alternative: string, body: string) => {
    world.selector = new AccountSelector([prefix], { strategy: 'fill-first' });
    await post(world, body, prefix, [alternative]);
    await post(world, body, prefix, [alternative]);
  }
);

Then('the agent receives the status {int}', (world, status: number) => {
  expect(world.responses.at(-1)!.status).toBe(status);
});

Then('the answer says {string}', async (world, text: string) => {
  expect(await world.responses.at(-1)!.text()).toContain(text);
});

Then('the proxy was sent the models {string}', (world, models: string) => {
  expect(world.sent.join(', ')).toBe(models);
});

Then(
  'both answers have the status {int} and say {string}',
  async (world, status: number, text: string) => {
    expect(world.responses).toHaveLength(2);
    for (const response of world.responses) {
      expect(response.status).toBe(status);
      expect(await response.clone().text()).toContain(text);
    }
  }
);

Then('both answers say {string}', async (world, text: string) => {
  for (const response of world.responses)
    expect(await response.clone().text()).toContain(text);
});

Then('the proxy was asked once', (world) => {
  expect(world.sent).toHaveLength(1);
});

Then(
  /^the relay waited for ([\d, ]+) seconds in turn$/,
  (world, seconds: string) => {
    expect(world.waits).toEqual(seconds.split(', ').map(Number));
    expect(world.waits).toEqual(RETRY_DELAYS);
  }
);

When(
  'an unpinned {string} launch is prepared with a relay at {string}',
  async (world, tool: string, url: string) => {
    world.relayed = await routeThroughRelay(
      world.relayEnv,
      select('node', tool, 'proxy'),
      {
        relay: () => ({ url, stop: () => undefined }),
        policy: () => undefined,
      }
    );
  }
);

Then(
  'its environment sets {string} to {string}',
  (world, name: string, value: string) => {
    expect(world.relayEnv[name]).toBe(value);
  }
);

Then('it is given the arguments {string}', (world, line: string) => {
  expect(world.relayed?.args).toEqual([
    line.slice(0, 2),
    line.slice(3).replace(/\\"/g, '"'),
  ]);
});

Then('no relay is started', (world) => {
  expect(world.relayed).toBeNull();
});

let latency = 0;
let status = 0;
Given(
  'the proxy answers with the status {int} after {int} ms',
  (_world, answered: number, milliseconds: number) => {
    status = answered;
    latency = milliseconds;
  }
);

When('this node checks that it reaches the proxy', async (world) => {
  let ticks = 0;
  world.checks = [
    await proxyReachableCheck(
      'https://proxy.example',
      (async () => new Response('', { status })) as unknown as typeof fetch,
      () => (ticks++ === 0 ? 0 : latency)
    ),
  ];
});

// ── Sessions ─────────────────────────────────────────────────────────────

Given('the sessions answer:', (world, table: DataTable) => {
  world.sessions = Object.fromEntries(
    table
      .hashes()
      .map((row) => [row['account']!, row['result'] as SessionResult])
  );
});

When('the account sessions are checked', async (world) => {
  world.checks = await accountSessionChecks(
    accountsFrom(world.models),
    world.exposed,
    async (instance) => {
      world.sessionsRun.push(instance.account);
      return world.sessions[instance.account] ?? 'failed';
    }
  );
});

Then('the checks are:', (world, table: DataTable) => {
  expect(world.checks.map((check) => `${check.id} ${check.status}`)).toEqual(
    table.hashes().map((row) => `${row['id']} ${row['status']}`)
  );
});

Then('only the account {string} was run', (world, account: string) => {
  expect(world.sessionsRun).toEqual([account]);
});

When(
  /^a session that (succeeded|failed) printed "(.*)" is read$/,
  (world, exit: string, output: string) => {
    world.result = sessionResult(exit === 'succeeded', output);
  }
);

Then('its account is {string}', (world, result: string) => {
  expect(world.result).toBe(result as SessionResult);
});

async function session(world: AccountsWorld, version: string): Promise<void> {
  world.cache ??= world.temporary();
  await cachedCheck(
    'account-node-claude-a',
    cacheKey('node', { tool: 'claude', account: 'a' }, version, 'key-1'),
    async () => {
      world.computed++;
      return { id: 'account-session', status: 'pass', summary: 'ok' };
    },
    { directory: world.cache, now: NOW }
  );
}

Given(
  'a session check passed under the roster version {string}',
  (world, version: string) => session(world, version)
);

When(
  'the session is checked again under the roster version {string}',
  (world, version: string) => session(world, version)
);

Then('the session was run again', (world) => {
  expect(world.computed).toBe(2);
});
