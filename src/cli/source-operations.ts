import type { Command } from 'commander';
import type { CommandOutcome } from './contracts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** These owners install from Git (a service keeps the commit it runs), so
 * they run from a checkout: the one this CLI is in, or, for an installed
 * package, the fleet-owned checkout of the revision fleet-sync applied on
 * this machine. Null before the first fleet-sync.
 */
export function ownerCheckout(
  workspace: string,
  home = homedir()
): string | null {
  if (existsSync(join(workspace, '.git'))) return workspace;
  const applied = join(home, '.local/share/personal/fleet/current');
  return existsSync(join(applied, '.git')) ? applied : null;
}

const CHECKOUT_REQUIRED =
  'This command runs from the revision fleet-sync applied on this machine, and none is applied yet. Run devfleet fleet-sync first.\n';

export async function forwardSourceOperation(
  args: string[],
  settings: Settings
): Promise<number> {
  const operation = SOURCE_OPERATIONS[args[0]!]!;
  const [runtime, ...ownerArgs] = operation.command;
  const checkout = ownerCheckout(settings.workspace);
  if (!checkout) {
    process.stderr.write(CHECKOUT_REQUIRED);
    return 1;
  }
  const resolved = ownerArgs.map((arg) =>
    arg.includes('/') ? join(checkout, arg) : arg
  );
  return new Promise((resolve) => {
    const child = spawn(runtime!, [...resolved, ...args.slice(1)], {
      cwd: checkout,
      stdio: 'inherit',
    });
    child.on('error', () => {
      process.stderr.write(
        'This command requires python3 and the toolchain fleet-sync installs.\n'
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
