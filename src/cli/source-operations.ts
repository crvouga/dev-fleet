import type { Command } from 'commander';
import type { CommandOutcome } from './contracts';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Settings } from './settings';

interface SourceOperation {
  title: string;
  description: string;
  keywords: string[];
  mutation: boolean;
  command: string[];
}

/** Commands implemented by another owner in this checkout and streamed through. */
export const SOURCE_OPERATIONS: Record<string, SourceOperation> = {
  cliproxy: {
    title: 'CLIProxyAPI service',
    description:
      'Install, inspect, back up, recover and validate model health (model-health, model-suite) of the CLIProxyAPI service.',
    keywords: ['cliproxy', 'codex', 'proxy', 'compose', 'backup', 'models'],
    mutation: true,
    command: ['python3', '-B', 'cliproxy/scripts/cli.py'],
  },
};

export function sourceOperation(args: string[]): string | undefined {
  return args[0] && Object.hasOwn(SOURCE_OPERATIONS, args[0])
    ? args[0]
    : undefined;
}

export async function forwardSourceOperation(
  args: string[],
  settings: Settings
): Promise<number> {
  const operation = SOURCE_OPERATIONS[args[0]!]!;
  const [runtime, ...ownerArgs] = operation.command;
  const resolved = ownerArgs.map((arg) =>
    arg.includes('/') ? join(settings.workspace, arg) : arg
  );
  return new Promise((resolve) => {
    const child = spawn(runtime!, [...resolved, ...args.slice(1)], {
      cwd: settings.workspace,
      stdio: 'inherit',
    });
    child.on('error', () => {
      process.stderr.write(
        'This command requires the dev-fleet checkout and its toolchain.\n'
      );
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export function registerSourceOperations(
  program: Command,
  defaults: Settings,
  complete: (result: CommandOutcome) => void
): void {
  for (const [name, operation] of Object.entries(SOURCE_OPERATIONS))
    program
      .command(`${name} [args...]`)
      .description(operation.title)
      .allowUnknownOption()
      .addHelpText(
        'after',
        `\n${operation.description}\nArguments are forwarded to the owning implementation; run devfleet ${name} help for its usage.`
      )
      .action(async (args: string[]) => {
        const exitCode = await forwardSourceOperation(
          [name, ...args],
          defaults
        );
        complete({ exitCode, data: { version: 1, ok: exitCode === 0 } });
      });
}
