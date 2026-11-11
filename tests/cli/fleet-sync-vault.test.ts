import { expect, test } from 'bun:test';
import {
  authorizeManager,
  authorizeVault,
  remote,
  workerTokenField,
} from '../../src/cli/fleet-sync-vault';
import type { CommandOptions, CommandResult, FleetNode } from '../../src/types';

const node: FleetNode = {
  id: 'worker-one',
  ssh: 'worker-one',
  workspace: '/home/dev/.local/share/personal/fleet',
  required: [],
};
const TOKEN = 'hvs.issued-worker-token-0123456789';

function result(ok: boolean, stdout = ''): CommandResult {
  return { ok, stdout, stderr: '', reason: 'exit' };
}

/** Answers each command from the first matching rule; records every call. */
function runner(rules: Array<[RegExp, CommandResult[]]>) {
  const calls: Array<{ command: string; input?: string }> = [];
  const run = async (args: string[], options?: CommandOptions) => {
    const command = args.join(' ');
    calls.push({
      command,
      ...(options?.input ? { input: options.input } : {}),
    });
    const rule = rules.find(([pattern]) => pattern.test(command));
    return rule?.[1].shift() ?? result(false);
  };
  return { run, calls };
}

const neverPrompt = () => {
  throw new Error('must not prompt');
};

test('worker token field matches the OpenTofu sink name', () => {
  expect(workerTokenField('worker-two')).toBe('FLEET_WORKER_TOKEN_WORKER_TWO');
});

test('an authenticated node passes without reading or prompting', async () => {
  const { run, calls } = runner([[/token.*lookup/, [result(true)]]]);
  const checks = await authorizeVault(
    node,
    { interactive: true },
    run,
    neverPrompt
  );
  expect(checks.map((check) => check.status)).toEqual(['pass']);
  expect(calls).toHaveLength(1);
});

test('a node without vault installed is deferred until after bootstrap', async () => {
  const { run } = runner([[/token.*lookup/, [result(false, 'vault-missing')]]]);
  expect(
    await authorizeVault(node, { interactive: true }, run, neverPrompt)
  ).toEqual([]);
});

test('the issued worker token is delivered over stdin, never as an argument', async () => {
  const { run, calls } = runner([
    [/token.*lookup/, [result(false), result(true)]],
    [/kv.*get/, [result(true, TOKEN + '\n')]],
    [/vault' 'login/, [result(true)]],
  ]);
  const checks = await authorizeVault(
    node,
    { interactive: false },
    run,
    neverPrompt
  );
  expect(checks.map((check) => check.status)).toEqual(['pass']);
  const read = calls.find((call) => /kv get/.test(call.command));
  expect(read?.command).toContain('-field=FLEET_WORKER_TOKEN_WORKER_ONE');
  const login = calls.find((call) => /vault' 'login/.test(call.command));
  expect(login?.input).toBe(TOKEN + '\n');
  expect(calls.every((call) => !call.command.includes(TOKEN))).toBe(true);
});

test('noninteractive sync without an issued token reports the gap', async () => {
  const { run } = runner([[/token.*lookup/, [result(false)]]]);
  const checks = await authorizeVault(
    node,
    { interactive: false },
    run,
    neverPrompt
  );
  expect(checks[0]?.summary).toBe('VAULT_LOGIN_REQUIRED');
});

test('interactive sync falls back to a password login on the node terminal', async () => {
  const attached: string[][] = [];
  const { run } = runner([[/token.*lookup/, [result(false), result(true)]]]);
  const checks = await authorizeVault(
    node,
    { interactive: true },
    run,
    (args) => {
      attached.push(args);
      return true;
    }
  );
  expect(checks.map((check) => check.status)).toEqual(['pass']);
  expect(attached[0]).toContain('-t');
  expect(attached[0]?.at(-1)).toContain("'-method=userpass'");
});

test('manager login prompts only when interactive and not logged in', async () => {
  let prompts = 0;
  const attach = () => {
    prompts += 1;
    return true;
  };
  expect(
    await authorizeManager(
      { interactive: true },
      runner([[/lookup/, [result(true)]]]).run,
      attach
    )
  ).toBe(true);
  expect(
    await authorizeManager({ interactive: false }, runner([]).run, attach)
  ).toBe(false);
  expect(prompts).toBe(0);
  expect(
    await authorizeManager(
      { interactive: true },
      runner([[/lookup/, [result(false), result(true)]]]).run,
      attach
    )
  ).toBe(true);
  expect(prompts).toBe(1);
});

test('remote commands keep verified host keys and only toggle the terminal', () => {
  const args = remote(node, ['vault', 'status'], '-t');
  expect(args).toContain('-t');
  expect(args).not.toContain('-T');
  expect(args).toContain('StrictHostKeyChecking=yes');
});
