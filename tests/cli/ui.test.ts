import { expect, test } from 'bun:test';
import { paletteChoices, runInteractive } from '../../src/cli/ui-controller';
import { inspectChecks } from '../../src/cli/ui-reports';
import { showOutcome } from '../../src/cli/ui-execute';
import { clean } from '../../src/cli/ui-data';
import { COMMANDS } from '../../src/cli/registry';
import type { Display, Prompts, Session } from '../../src/cli/ui-types';
import type { CommandOutcome } from '../../src/cli/contracts';

function harness(
  answers: {
    search?: string[];
    select?: string[];
    input?: string[];
    confirm?: boolean[];
  } = {}
) {
  const writes: string[] = [];
  const calls: string[][] = [];
  const questions: string[] = [];
  const prompts: Prompts = {
    search: async (message, source) => {
      questions.push(message);
      expect(source('')).toBeArray();
      return answers.search?.shift() ?? 'exit';
    },
    select: async (message) => {
      questions.push(message);
      return answers.select?.shift() ?? 'back';
    },
    input: async () => answers.input?.shift() ?? '',
    checkbox: async () => ['github', 't3'],
    confirm: async () => answers.confirm?.shift() ?? false,
  };
  const display: Display = {
    write: (value) => {
      writes.push(value);
    },
    panel: (title, body) => {
      writes.push(`${title}\n${body}`);
    },
    table: (_headers, rows) => {
      writes.push(JSON.stringify(rows));
    },
    progress: () => ({ stop: () => undefined }),
  };
  const options = {
    version: '1.2.3',
    releasedAt: '2026-01-02T03:04:05.000Z',
    workspace: '/workspace',
    config: '/fleet.json',
    commands: COMMANDS,
    execute: async (args: string[]): Promise<CommandOutcome> => {
      calls.push(args);
      return { exitCode: 0, data: { version: 1, ok: true, nodes: [] } };
    },
  };
  return { prompts, display, options, writes, calls, questions };
}

test('local command shortcut does not ask for remote targets', async () => {
  const fixture = harness({ search: ['command:fleet-status --local', 'exit'] });
  await runInteractive(fixture.options, fixture.prompts, fixture.display);
  expect(fixture.calls).toEqual([['fleet-status', '--local']]);
  expect(fixture.questions).not.toContain('Choose target scope');
  expect(fixture.writes.join('\n')).toContain('--json');
});

test('add-node wizard cannot mutate without explicit approval', async () => {
  const fixture = harness({
    search: ['command:fleet-node-add', 'exit'],
    input: ['dev-one', 'dev-one', '/home/dev/workspace', ''],
    confirm: [false],
  });
  await runInteractive(fixture.options, fixture.prompts, fixture.display);
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.writes.join('\n')).toContain('no roster was written');
});

test('confirmed wizard invokes the same explicit agent-friendly command', async () => {
  const fixture = harness({
    search: ['command:fleet-node-add', 'exit'],
    input: ['dev-one', 'dev-one', '/home/dev/workspace', '/usr/bin/node'],
    confirm: [true],
  });
  await runInteractive(fixture.options, fixture.prompts, fixture.display);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toEqual([
    'fleet-node-add',
    '--id',
    'dev-one',
    '--ssh',
    'dev-one',
    '--path',
    '/home/dev/workspace',
    '--runtime',
    '/usr/bin/node',
    '--require',
    'github,t3',
    '--apply',
    '--yes',
  ]);
});

test('report filters retain remedies and never execute suggested commands', async () => {
  const fixture = harness({
    search: ['status', '0', 'back'],
    select: ['fail'],
  });
  const session: Session = fixture;
  await inspectChecks(session, {
    nodes: [
      {
        node: 'dev',
        checks: [
          { id: 'ok', status: 'pass', summary: 'fine' },
          {
            id: 'ssh:auth',
            status: 'fail',
            summary: 'SSH key rejected',
            remedy: { action: 'Inspect keys locally', command: 'ssh-add -l' },
          },
        ],
      },
    ],
  });
  expect(
    fixture.questions.some((question) => question.includes('1/2 checks'))
  ).toBe(true);
  expect(fixture.writes.join('\n')).toContain(
    'Suggested operator command (not executed)'
  );
  expect(fixture.calls).toHaveLength(0);
});

test('cancellation exits safely without printing the thrown message', async () => {
  const fixture = harness();
  fixture.prompts.search = async () => {
    const error = new Error('private-stack-token');
    error.name = 'ExitPromptError';
    throw error;
  };
  await expect(
    runInteractive(fixture.options, fixture.prompts, fixture.display)
  ).rejects.toThrow();
  expect(fixture.writes.join('\n')).not.toContain('private-stack-token');
  expect(fixture.calls).toHaveLength(0);
});

test('terminal text strips escape sequences and control characters', () => {
  expect(clean('\x1b[31mred\x1b[0m\x1b]0;title\x07\nvalue')).toBe('red value');
});

test('palette is flat, sorted A–Z, searchable, and has one entry per command', () => {
  const fixture = harness();
  const choices = paletteChoices(fixture, '');
  const names = choices.map((choice) => choice.name);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  expect(choices.some((choice) => choice.value.startsWith('group:'))).toBe(
    false
  );
  expect(
    choices.filter((choice) => choice.value.startsWith('command:'))
  ).toHaveLength(COMMANDS.length);
  expect(
    paletteChoices(fixture, 'nodes').some(
      (choice) => choice.value === 'command:fleet-nodes'
    )
  ).toBe(true);
});

test('repair approval carries the reviewed plan hash into the exact apply command', async () => {
  const fixture = harness({
    search: ['command:fleet-repair', 'exit'],
    select: ['local', 'apply', 'back'],
    confirm: [true],
  });
  fixture.options.execute = async (args): Promise<CommandOutcome> => {
    fixture.calls.push(args);
    return {
      exitCode: 0,
      data: {
        version: 1,
        command: 'repair',
        ok: true,
        applied: args.includes('--apply'),
        planHash: 'b'.repeat(64),
        nodes: [],
        steps: [],
      },
    };
  };
  await runInteractive(fixture.options, fixture.prompts, fixture.display);
  expect(fixture.calls).toEqual([
    ['fleet-repair', '--local'],
    [
      'fleet-repair',
      '--local',
      '--plan-hash',
      'b'.repeat(64),
      '--apply',
      '--yes',
    ],
  ]);
  expect(fixture.writes.join('\n')).toContain('Vault');
});

test('failed applied repairs report attempted actions instead of claiming nothing ran', () => {
  const fixture = harness();
  showOutcome(fixture, {
    exitCode: 1,
    data: {
      command: 'repair',
      applied: true,
      ok: false,
      executionOk: true,
      healthOk: false,
      completed: 1,
      nodes: [],
      steps: [],
    },
  });
  expect(fixture.writes.join('\n')).toContain('Actions were attempted');
  expect(fixture.writes.join('\n')).not.toContain(
    'No automatic repair was attempted'
  );
});
