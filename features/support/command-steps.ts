import { expect } from 'bun:test';
import type { Check, CommandResult, Runner } from '../../src/types';
import { Commands, succeeded } from './commands';
import { World, type DataTable, type Steps } from './gherkin';
import { ANSWER, answer, commandLine } from './answers';

/** A scenario whose situation is what each command answers and whose outcome
 * is a list of checks, or a refusal.
 */
export class CommandWorld extends World {
  readonly commands = new Commands();
  /** What a command the scenario did not describe answers. Without it such a
   * command fails the scenario: nothing runs that the feature does not name.
   */
  otherwise: CommandResult | undefined;
  /** Written to the error stream of every command, when the scenario says so. */
  errorStream: string | undefined;
  checks: Check[] = [];
  /** What the scenario's `When` threw, for a `Then` to name. */
  failure: unknown;

  constructor() {
    super();
    // Registered first, so every answer a scenario describes is tried before it.
    this.commands.answer(
      () => true,
      (command) => {
        if (this.otherwise) return this.otherwise;
        throw new Error(
          `The scenario does not say what this command answers: ${command.join(' ')}`
        );
      }
    );
  }

  readonly run: Runner = async (command, options) => {
    const result = await this.commands.run(command, options);
    return this.errorStream === undefined
      ? result
      : { ...result, stderr: this.errorStream };
  };

  /** Runs what a `When` describes and keeps a refusal instead of throwing. */
  async attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.failure = error;
    }
  }

  /** The first check reported; a refusal nobody expected is thrown here. */
  get check(): Check {
    if (this.failure !== undefined) throw this.failure;
    expect(this.checks.length).toBeGreaterThan(0);
    return this.checks[0]!;
  }

  get lines(): string[] {
    return this.commands.calls.map((call) => call.command.join(' '));
  }
}

/** The steps every such scenario shares: what commands answer, which ran, and
 * what the first check says.
 */
export function commandSteps<W extends CommandWorld>(registry: Steps<W>): void {
  const { Given, Then } = registry;

  Given('these commands answer:', (world, table: DataTable) => {
    for (const row of table.hashes())
      world.commands.answer(
        commandLine(row['command'] ?? ''),
        answer(row['answer'] ?? '')
      );
  });

  Given(
    new RegExp(`^the command "([^"]+)" ${ANSWER}$`),
    (world, command: string, written: string) => {
      world.commands.answer(commandLine(command), answer(written));
    }
  );

  Given('the command {string} prints:', (world, command: string, text) => {
    world.commands.answer(commandLine(command), succeeded(String(text)));
  });

  Given(
    'the command {string} answers in turn:',
    (world, command: string, table: DataTable) => {
      // The last answer is repeated for as long as the command is asked.
      const turns = table.list().map(answer);
      world.commands.answer(commandLine(command), () =>
        turns.length > 1 ? turns.shift()! : turns[0]!
      );
    }
  );

  Given(
    new RegExp(`^every (?:other )?command ${ANSWER}$`),
    (world, written: string) => {
      world.otherwise = answer(written);
    }
  );

  Given(
    'every command times out, printing {string} on both streams',
    (world, text: string) => {
      world.otherwise = {
        ok: false,
        stdout: text,
        stderr: text,
        reason: 'timeout',
      };
    }
  );

  Given(
    'every command also writes {string} to its error stream',
    (world, text: string) => {
      world.errorStream = text;
    }
  );

  Then('{int} command(s) ran', (world, count: number) => {
    expect(world.lines).toHaveLength(count);
  });

  Then('only these commands ran:', (world, table: DataTable) => {
    expect(world.lines).toEqual(table.list());
  });

  Then('every command that ran was {string}', (world, line: string) => {
    expect(world.commands.calls.length).toBeGreaterThan(0);
    for (const call of world.commands.calls)
      expect(call.command).toEqual(line.split(' '));
  });

  Then('every command that ran was a {string} command', (world, name) => {
    expect(world.commands.calls.length).toBeGreaterThan(0);
    for (const call of world.commands.calls)
      expect(call.command[0]).toBe(String(name));
  });

  Then('every command was given {int} ms', (world, timeoutMs: number) => {
    expect(world.commands.calls.length).toBeGreaterThan(0);
    for (const call of world.commands.calls)
      expect(call.options?.timeoutMs).toBe(timeoutMs);
  });

  const withWord = (world: W, words: string[]): string[] =>
    world.commands.calls
      .filter((call) => call.command.some((word) => words.includes(word)))
      .map((call) => call.command.join(' '));

  Then(
    'no command with any of these words was run:',
    (world, table: DataTable) => {
      expect(withWord(world, table.list())).toEqual([]);
    }
  );

  Then('no command with the word {string} was run', (world, word: string) => {
    expect(withWord(world, [word])).toEqual([]);
  });

  Then('no command contains {string}', (world, text: string) => {
    const words = world.commands.calls.flatMap((call) => call.command);
    expect(words.join(' ')).not.toContain(text);
  });

  Then(/^the check (passes|fails|warns)$/, (world, verdict: string) => {
    expect(world.check.status).toBe(
      ({ passes: 'pass', fails: 'fail', warns: 'warn' } as const)[
        verdict as 'passes' | 'fails' | 'warns'
      ]
    );
  });

  Then('the check fails with {string}', (world, summary: string) => {
    expect(world.check.summary).toBe(summary);
    expect(world.check.status).toBe('fail');
  });

  Then('the check is {string}', (world, id: string) => {
    expect(world.check.id).toBe(id);
  });

  Then('the summary of the check is {string}', (world, summary: string) => {
    expect(world.check.summary).toBe(summary);
  });

  Then('the remedy of the check contains {string}', (world, text: string) => {
    expect(world.check.remedy?.action).toContain(text);
  });

  Then(
    'the remedy of the check does not contain {string}',
    (world, text: string) => {
      expect(world.check.remedy?.action).not.toContain(text);
    }
  );

  Then('the checks do not contain {string}', (world, text: string) => {
    if (world.failure !== undefined) throw world.failure;
    expect(world.checks.length).toBeGreaterThan(0);
    expect(JSON.stringify(world.checks)).not.toContain(text);
  });

  Then('it is refused with {string}', (world, message: string) => {
    expect(world.failure).toBeInstanceOf(Error);
    expect((world.failure as Error).message).toContain(message);
  });
}
