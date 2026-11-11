import { checkbox, confirm, input, search, select } from '@inquirer/prompts';
import { Chalk } from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import Table from 'cli-table3';
import { clean } from './ui-data';
import type { Display, Prompts } from './ui-types';

function plainTerminal(): boolean {
  return (
    process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb'
  );
}

function pageSize(): number {
  return Math.max(3, Math.min(10, (process.stderr.rows || 24) - 10));
}

export function terminalPrompts(): Prompts {
  const context = { output: process.stderr, clearPromptOnDone: false };
  return {
    select: (message, choices) =>
      select({ message, choices, pageSize: pageSize(), loop: false }, context),
    search: (message, source) =>
      search(
        {
          message,
          source: (term) => source(term ?? ''),
          pageSize: pageSize(),
          theme: { style: { highlight: (value: string) => value } },
        },
        context
      ),
    checkbox: (message, choices) =>
      checkbox(
        { message, choices, pageSize: pageSize(), loop: false },
        context
      ),
    input: (message, initial = '', validate = () => true) =>
      input({ message, default: initial, validate }, context),
    confirm: (message) => confirm({ message, default: false }, context),
  };
}

export function terminalDisplay(): Display {
  const color = new Chalk({
    level: !plainTerminal() && process.stderr.isTTY ? 1 : 0,
  });
  const write = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  return {
    write,
    panel: (title, body) => {
      const content = `${color.bold(clean(title))}\n${body}`;
      if ((process.stderr.columns || 80) < 48 || plainTerminal()) {
        write(`\n${content}\n`);
        return;
      }
      write(
        boxen(content, {
          padding: 1,
          borderStyle: 'round',
          ...(color.level ? { borderColor: 'cyan' as const } : {}),
          width: Math.min(process.stderr.columns || 80, 96),
        })
      );
    },
    table: (headers, rows) => drawTable(write, headers, rows),
    progress: (message) => {
      const spinner = ora({
        text: message,
        stream: process.stderr,
        isEnabled: Boolean(process.stderr.isTTY) && !plainTerminal(),
        isSilent: !process.stderr.isTTY || plainTerminal(),
        discardStdin: false,
      });
      if (spinner.isEnabled) spinner.start();
      else write(`… ${message}`);
      return {
        stop: () => {
          spinner.stop();
        },
      };
    },
  };
}

function drawTable(
  write: (text: string) => void,
  headers: string[],
  rows: string[][]
): void {
  if ((process.stderr.columns || 80) < 64 || plainTerminal()) {
    rows.forEach((row) => write(row.map((cell) => clean(cell)).join(' · ')));
    return;
  }
  const width = Math.floor(
    ((process.stderr.columns || 80) - headers.length * 3 - 1) / headers.length
  );
  const table = new Table({
    head: headers,
    colWidths: headers.map(() => Math.max(8, width)),
    wordWrap: true,
    style: { head: [], border: [] },
  });
  table.push(...rows.map((row) => row.map((cell) => clean(cell))));
  write(table.toString());
}
