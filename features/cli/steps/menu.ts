import { expect } from 'bun:test';
import type { CommandOutcome } from '../../../src/cli/contracts';
import { COMMANDS } from '../../../src/cli/registry';
import { paletteChoices, runInteractive } from '../../../src/cli/ui-controller';
import { clean } from '../../../src/cli/ui-data';
import { showOutcome } from '../../../src/cli/ui-execute';
import { inspectChecks } from '../../../src/cli/ui-reports';
import type {
  Choice,
  Display,
  Prompts,
  Session,
} from '../../../src/cli/ui-types';
import type { DataTable } from '../../support/gherkin';
import { attempt, cli, json, listed, part, refusal } from './world';

const { Given, When, Then } = cli;

/** The interactive menu with an operator who answers as the scenario says.
 * An answer nobody scripted leaves the place it was asked: "exit" from the
 * palette, "back" from a list, nothing typed, nothing confirmed.
 */
class Menu implements Session {
  readonly picks: string[] = [];
  readonly selections: string[] = [];
  readonly typed: string[] = [];
  readonly confirmations: boolean[] = [];
  ticked: string[] = [];
  cancellation: Error | undefined;
  /** Everything put on the screen, every command run, every question asked. */
  readonly screen: string[] = [];
  readonly ran: string[][] = [];
  readonly questions: string[] = [];
  answer: (args: string[]) => CommandOutcome = () => ({
    exitCode: 0,
    data: undefined,
  });
  report: unknown;
  choices: Choice[] = [];
  cleaned = '';

  readonly options: Session['options'] = {
    version: '',
    releasedAt: null,
    workspace: '',
    config: '',
    commands: COMMANDS,
    execute: async (args) => {
      this.ran.push(args);
      return this.answer(args);
    },
  };
  readonly prompts: Prompts = {
    search: async (message, source) => {
      if (this.cancellation) throw this.cancellation;
      this.questions.push(message);
      // Whatever is searched for, the operator is offered a list.
      expect(source('')).toBeArray();
      return this.picks.shift() ?? 'exit';
    },
    select: async (message) => {
      this.questions.push(message);
      return this.selections.shift() ?? 'back';
    },
    input: async () => this.typed.shift() ?? '',
    checkbox: async () => this.ticked,
    confirm: async () => this.confirmations.shift() ?? false,
  };
  readonly display: Display = {
    write: (value) => {
      this.screen.push(value);
    },
    panel: (title, body) => {
      this.screen.push(`${title}\n${body}`);
    },
    table: (_headers, rows) => {
      this.screen.push(JSON.stringify(rows));
    },
    progress: () => ({ stop: () => undefined }),
  };
}

const menu = part(() => new Menu());

// ── The menu and its operator ────────────────────────────────────────────

Given(
  'the interactive menu of devfleet {string}, released at {string}, for the workspace {string} and the roster {string}',
  (world, ...[version, releasedAt, workspace, config]: string[]) => {
    Object.assign(menu(world).options, {
      version,
      releasedAt,
      workspace,
      config,
    });
  }
);

Given('every command the menu runs answers:', (world, document: string) => {
  menu(world).answer = () => ({ exitCode: 0, data: json(document) });
});

Given(
  'every command the menu runs answers this, as applied only when run with {string}:',
  (world, flag: string, document: string) => {
    menu(world).answer = (args) => ({
      exitCode: 0,
      data: {
        ...(json(document) as Record<string, unknown>),
        applied: args.includes(flag),
      },
    });
  }
);

Given(
  'the operator ticks {string} whenever a list of boxes is offered',
  (world, ticked: string) => {
    menu(world).ticked = listed(ticked);
  }
);

Given(
  'the operator opens {string} from the palette, then exits',
  (world, command: string) => {
    menu(world).picks.push(`command:${command}`, 'exit');
  }
);

Given(
  'the operator picks from each search, in turn:',
  (world, table: DataTable) => {
    menu(world).picks.push(...table.list());
  }
);

Given(
  'the operator picks from each list, in turn:',
  (world, table: DataTable) => {
    menu(world).selections.push(...table.list());
  }
);

Given('the operator types, in turn:', (world, table: DataTable) => {
  menu(world).typed.push(...table.list());
});

Given(/^the operator (confirms|declines) when asked$/, (world, how: string) => {
  menu(world).confirmations.push(how === 'confirms');
});

Given(
  'the operator cancels at the palette, which raises an {string} that says {string}',
  (world, name: string, message: string) => {
    const error = new Error(message);
    error.name = name;
    menu(world).cancellation = error;
  }
);

Given('a report with these checks:', (world, table: DataTable) => {
  const nodes = new Map<string, unknown[]>();
  for (const row of table.hashes()) {
    const remedy = row['remedy']
      ? { remedy: { action: row['remedy'], command: row['command'] } }
      : {};
    nodes.set(row['machine']!, [
      ...(nodes.get(row['machine']!) ?? []),
      {
        id: row['id'],
        status: row['status'],
        summary: row['summary'],
        ...remedy,
      },
    ]);
  }
  menu(world).report = {
    nodes: [...nodes].map(([node, checks]) => ({ node, checks })),
  };
});

// ── What happens ─────────────────────────────────────────────────────────

When('the menu runs', async (world) => {
  const session = menu(world);
  await attempt(world, () =>
    runInteractive(session.options, session.prompts, session.display)
  );
});

When('the operator explores the checks of the report', async (world) => {
  await attempt(world, () => inspectChecks(menu(world), menu(world).report));
});

When('the palette is searched for {string}', (world, term: string) => {
  menu(world).choices = paletteChoices(menu(world), term);
});

When(
  'the menu shows a command that exited with {int} and answered:',
  (world, exitCode: number, document: string) => {
    showOutcome(menu(world), { exitCode, data: json(document) });
  }
);

/** `\x1b` and `\n` as a feature writes them, turned into the characters. */
const unescaped = (text: string): string =>
  text
    .replace(/\\x([0-9a-f]{2})/gi, (_, code: string) =>
      String.fromCharCode(parseInt(code, 16))
    )
    .replaceAll('\\n', '\n');

When(
  'this text, written with its escapes, is prepared for the terminal:',
  (world, text: string) => {
    menu(world).cleaned = clean(unescaped(text));
  }
);

// ── What can be observed ─────────────────────────────────────────────────

Then('the menu runs exactly these commands:', (world, table: DataTable) => {
  expect(menu(world).ran).toEqual(table.list().map((line) => line.split(' ')));
});

Then('the menu runs no command', (world) => {
  expect(menu(world).ran).toHaveLength(0);
});

Then('the operator is never asked {string}', (world, question: string) => {
  expect(menu(world).questions).not.toContain(question);
});

Then(
  'the operator is asked a question containing {string}',
  (world, part: string) => {
    expect(
      menu(world).questions.some((question) => question.includes(part))
    ).toBe(true);
  }
);

Then('the screen shows {string}', (world, text: string) => {
  expect(menu(world).screen.join('\n')).toContain(text);
});

Then('the screen does not show {string}', (world, text: string) => {
  expect(menu(world).screen.join('\n')).not.toContain(text);
});

Then('the menu ends with an error', (world) => {
  expect(refusal(world)).toBeDefined();
});

Then('its entries are sorted by name, A to Z', (world) => {
  const names = menu(world).choices.map((choice) => choice.name);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
});

Then('none of its entries is a group', (world) => {
  expect(
    menu(world).choices.some((choice) => choice.value.startsWith('group:'))
  ).toBe(false);
});

Then('it has one entry for each command in the catalog', (world) => {
  expect(
    menu(world).choices.filter((choice) => choice.value.startsWith('command:'))
  ).toHaveLength(COMMANDS.length);
});

Then('it offers the command {string}', (world, id: string) => {
  expect(
    menu(world).choices.some((choice) => choice.value === `command:${id}`)
  ).toBe(true);
});

Then('it reads {string}', (world, text: string) => {
  expect(menu(world).cleaned).toBe(text);
});
