import { expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprint } from '../../../src/fingerprint';
import type { TailnetComputer } from '../../../src/tailscale';
import type { FleetNode } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import { workspace } from '../../support/fixtures';
import type { DataTable } from '../../support/gherkin';
import {
  capabilities,
  cell,
  isResolution,
  isSession,
  need,
  optional,
  orchestration,
  reportOf,
  sessions,
  type OrchestrationWorld,
} from '../support/world';

const { Given, Then } = orchestration;

// ── Checkouts and files ──────────────────────────────────────────────────

async function checkout(world: OrchestrationWorld): Promise<void> {
  const root = await workspace();
  world.defer(() => rm(root, { recursive: true, force: true }));
  world.root = root;
}

/** The input files of a checkout in a temporary directory. Git is not run:
 * asked for the commit it answers the one named here, and every command
 * nobody described succeeds and prints nothing.
 */
Given('a checkout at commit {string}', async (world, commit: string) => {
  await checkout(world);
  world.commands.otherwise = succeeded();
  world.commands.answer(
    (command) => command.includes('rev-parse'),
    succeeded(commit)
  );
});

Given('a checkout that holds no dev-fleet package', checkout);

Given('an empty directory', async (world) => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-'));
  world.defer(() => rm(root, { recursive: true, force: true }));
  world.root = root;
});

async function write(
  world: OrchestrationWorld,
  path: string,
  contents: string
): Promise<void> {
  const file = join(need(world.root, 'a directory'), path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}
Given('{string} then changes to {string}', write);
Given('the file {string} was written with {string}', write);

Then(
  'the file {string} still holds {string}',
  async (world, path: string, contents: string) => {
    expect(
      await readFile(join(need(world.root, 'a directory'), path), 'utf8')
    ).toBe(contents);
  }
);

Given(
  'the fingerprint of the checkout was taken as the reference',
  async (world) => {
    world.reference = await fingerprint(
      need(world.root, 'a checkout'),
      world.run
    );
  }
);

// ── Workers and the tailnet ──────────────────────────────────────────────

Given(
  'the manager has these workers registered:',
  (world, table: DataTable) => {
    world.nodes = table.hashes().map((row): FleetNode => {
      const tailscaleId = optional(row, 'tailscale id');
      return {
        id: cell(row, 'id'),
        ssh: cell(row, 'ssh'),
        workspace: cell(row, 'workspace'),
        required: capabilities(optional(row, 'required')),
        ...(tailscaleId ? { tailscaleId } : {}),
      };
    });
  }
);

Given('the manager has no worker registered', (world) => {
  world.nodes = [];
});

Given(
  'the worker {string} at the SSH alias {string} works in that checkout',
  (world, id: string, ssh: string) => {
    world.nodes = [
      { id, ssh, workspace: need(world.root, 'a checkout'), required: [] },
    ];
  }
);

/** Without a column for it, a computer's Tailscale ID is its name. */
Given('the tailnet shows these computers:', (world, table: DataTable) => {
  world.computers = table.hashes().map((row): TailnetComputer => ({
    id: optional(row, 'tailscale id') || cell(row, 'name'),
    name: cell(row, 'name'),
    dns: cell(row, 'dns'),
    os: 'linux',
    ips: [cell(row, 'address')],
    online: cell(row, 'online') === 'yes',
    self: cell(row, 'this manager') === 'yes',
  }));
});

Given('{string} is offline in the tailnet', (world, name: string) => {
  need(
    world.computers.find((computer) => computer.name === name),
    `a computer named "${name}"`
  ).online = false;
});

Given(
  'every SSH alias resolves to its own name in the tailnet {string}',
  (world, tailnet: string) => {
    world.commands.answer(isResolution, (command) =>
      succeeded(`hostname ${command.at(-1)}.${tailnet}\n`)
    );
  }
);

Given(
  'the SSH alias {string} resolves to {string}',
  (world, alias: string, host: string) => {
    world.commands.answer(
      (command) => isResolution(command) && command.at(-1) === alias,
      succeeded(`hostname ${host}\n`)
    );
  }
);

Given('the probe source is {string}', (world, source: string) => {
  world.probe.source = source;
});

// ── What commands answer ─────────────────────────────────────────────────

function everyCommandSucceeds(world: OrchestrationWorld, output: string): void {
  world.commands.otherwise = succeeded(output);
}
Given('every command succeeds, printing {string}', everyCommandSucceeds);
Given('every other command succeeds, printing {string}', everyCommandSucceeds);

Given(
  'every command fails, printing {string} and the error output {string}',
  (world, output: string, error: string) => {
    world.commands.otherwise = { ...failed(error), stdout: output };
  }
);

Given(
  'any {string} command fails with the error output {string}',
  (world, executable: string, error: string) => {
    world.commands.answer(
      (command) => command[0] === executable,
      failed(error)
    );
  }
);

Given(
  'a command with the argument {string} succeeds, printing:',
  (world, argument: string, output: string) => {
    world.commands.answer(
      (command) => command.includes(argument),
      succeeded(output)
    );
  }
);

Given(
  'every command writes {string} to its error output',
  (world, noise: string) => {
    world.noise = noise;
  }
);

Given('every SSH session succeeds, printing:', (world, output: string) => {
  world.commands.answer(isSession, succeeded(output));
});

Given(
  'every SSH session fails with the error output {string}',
  (world, error: string) => {
    world.commands.answer(isSession, failed(error));
  }
);

// ── What was run ─────────────────────────────────────────────────────────

const ran = (world: OrchestrationWorld): string[][] =>
  world.commands.calls.map((call) => call.command);

Then('nothing but git was run', (world) => {
  expect(ran(world).length).toBeGreaterThan(0);
  expect(ran(world).every((command) => command[0] === 'git')).toBe(true);
});

Then('{int} command(s) was/were run', (world, count: number) => {
  expect(ran(world)).toHaveLength(count);
});

Then(
  'no command with the argument {string} was run',
  (world, argument: string) => {
    expect(ran(world).length).toBeGreaterThan(0);
    expect(ran(world).flat()).not.toContain(argument);
  }
);

Then(
  '{int} command(s) with the argument {string} was/were run',
  (world, count: number, argument: string) => {
    expect(
      ran(world).filter((command) => command.includes(argument))
    ).toHaveLength(count);
  }
);

Then('no SSH command was run', (world) => {
  expect(ran(world).filter((command) => command[0] === 'ssh')).toHaveLength(0);
});

Then('{int} tailscale command(s) was/were run', (world, count: number) => {
  expect(
    ran(world).filter((command) => command[0] === 'tailscale')
  ).toHaveLength(count);
});

Then(
  '{int} SSH session(s) was/were opened, and nothing else was run',
  (world, count: number) => {
    expect(sessions(world)).toHaveLength(count);
    expect(ran(world)).toHaveLength(count);
  }
);

Then(
  'every SSH session was opened with {string}',
  (world, argument: string) => {
    expect(sessions(world).length).toBeGreaterThan(0);
    for (const { command } of sessions(world))
      expect(command).toContain(argument);
  }
);

Then('every SSH session was fed {string}', (world, input: string) => {
  expect(sessions(world).length).toBeGreaterThan(0);
  for (const { options } of sessions(world)) expect(options?.input).toBe(input);
});

Then('no SSH session was fed anything', (world) => {
  expect(sessions(world).length).toBeGreaterThan(0);
  for (const { options } of sessions(world))
    expect(options?.input).toBeUndefined();
});

// ── What is reported about one checkout or worker ────────────────────────

Then('the first check has the status {string}', (world, status: string) => {
  expect<string | undefined>(world.checks[0]?.status).toBe(status);
});

Then('the first check is {string}', (world, id: string) => {
  expect(world.checks[0]?.id).toBe(id);
});

Then('the first check says {string}', (world, summary: string) => {
  expect(world.checks[0]?.summary).toBe(summary);
});

Then('a check says {string}', (world, summary: string) => {
  expect(world.checks.some((check) => check.summary === summary)).toBe(true);
});

Then(
  'the check {string} has the status {string}',
  (world, id: string, status: string) => {
    expect<string | undefined>(
      world.checks.find((check) => check.id === id)?.status
    ).toBe(status);
  }
);

Then('the checks are:', (world, table: DataTable) => {
  expect<Record<string, string>[]>(
    world.checks.map(({ id, status }) => ({ id, status }))
  ).toEqual(table.hashes());
});

Then('the statuses of the checks are, in order:', (world, table: DataTable) => {
  expect<string[]>(world.checks.map((check) => check.status)).toEqual(
    table.list()
  );
});

Then('at least one check has failed', (world) => {
  expect(world.checks.some((check) => check.status === 'fail')).toBe(true);
});

Then('no check has failed', (world) => {
  expect(world.checks.length).toBeGreaterThan(0);
  expect(world.checks.filter((check) => check.status === 'fail')).toEqual([]);
});

Then(/^every check has (passed|failed)$/, (world, outcome: string) => {
  const status = outcome === 'passed' ? 'pass' : 'fail';
  expect(world.checks.length).toBeGreaterThan(0);
  expect(world.checks.every((check) => check.status === status)).toBe(true);
});

// ── What is reported about several computers ─────────────────────────────

Then('the report covers, in order:', (world, table: DataTable) => {
  expect(world.reports.map((report) => report.node)).toEqual(table.list());
});

Then('{string} fails the check {string}', (world, node: string, id: string) => {
  expect(
    world.reports
      .find((report) => report.node === node)
      ?.checks.some((check) => check.id === id && check.status === 'fail')
  ).toBe(true);
});

Then(
  '{int} computers fail the check {string}',
  (world, count: number, id: string) => {
    expect(
      world.reports.filter((report) =>
        report.checks.some(
          (check) => check.id === id && check.status === 'fail'
        )
      )
    ).toHaveLength(count);
  }
);

Then(
  /^the (first|last) check of "([^"]+)" (is|says) "([^"]+)"$/,
  (world, which: string, node: string, verb: string, expected: string) => {
    const check = reportOf(world, node).checks.at(which === 'first' ? 0 : -1);
    expect(verb === 'is' ? check?.id : check?.summary).toBe(expected);
  }
);

Then(
  'the checks of {string} include {string}',
  (world, node: string, id: string) => {
    expect(reportOf(world, node).checks.some((check) => check.id === id)).toBe(
      true
    );
  }
);

Then('the report of {string} carries a snapshot', (world, node: string) => {
  expect(
    world.reports.find((report) => report.node === node)?.snapshot
  ).toBeDefined();
});

Then('{string} appears nowhere in what is reported', (world, text: string) => {
  expect(world.outcome).toBeDefined();
  expect(JSON.stringify(world.outcome)).not.toContain(text);
});
