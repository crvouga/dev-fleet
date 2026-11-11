import { Command, CommanderError } from 'commander';
import { FleetUsageError } from '../errors';
import { indexedCommands } from './command-index';
import { registerT3 } from './t3/register';
import { registerSourceOperations } from './source-operations';
import { registerFleet } from './register-fleet';
import { agentGuide } from './agent-guide';
import type { Settings } from './settings';
import type { CliOptions } from './options';
import type { CommandOutcome } from './contracts';

export interface Release {
  version: string;
  /** ISO timestamp recorded when this distribution was built; null for source runs. */
  releasedAt: string | null;
}

export const GLOBAL_OPTIONS = [
  {
    flag: '--json',
    description: 'One versioned JSON document on stdout; never prompt',
  },
  { flag: '--non-interactive', description: 'Never open interactive prompts' },
  {
    flag: '--workspace <path>',
    description: 'Existing manager checkout; does not clone or change it',
  },
  { flag: '--config <path>', description: 'Local, secret-free fleet roster' },
];

/** The version a checkout carries; a published package has a real one. */
export const SOURCE_VERSION = '0.0.0-development';

export function releaseLabel(release: Release): string {
  if (release.releasedAt)
    return `${release.version} (released ${release.releasedAt})`;
  return release.version === SOURCE_VERSION
    ? `${release.version} (unreleased source build)`
    : release.version;
}

function createProgram(
  release: Release,
  output: (text: string) => void
): Command {
  const program = new Command()
    .name('devfleet')
    .description('Developer fleet, T3 and platform operations')
    .version(releaseLabel(release))
    .exitOverride()
    .configureOutput({ writeOut: output, writeErr: () => undefined })
    .showSuggestionAfterError(false)
    .addHelpCommand('help [command]', 'Show help for a command')
    .option(
      '--interactive',
      'Open the interactive terminal application (TTY required)'
    );
  for (const option of GLOBAL_OPTIONS)
    program.option(option.flag, option.description);
  program.addHelpText(
    'after',
    [
      '',
      `Release: ${releaseLabel(release)}`,
      'Groups: fleet-* developer computers · t3-* T3 provider instances · cliproxy the CLI proxy service.',
      'Apply on invocation (--dry-run previews): fleet-node-sync, t3-apply, t3-cleanup. fleet-sync confirms interactively or with --apply --yes.',
      'Preview until --apply --yes: fleet-repair, fleet-node-add. --json does not make a command read-only.',
      'Agents: devfleet commands --json. Menu: devfleet --interactive.',
    ].join('\n')
  );
  return program;
}

function catalog(options: CliOptions, release: Release): CommandOutcome {
  const commands = indexedCommands(options.search, options.group);
  return {
    exitCode: 0,
    data: {
      version: 1,
      cliVersion: release.version,
      releasedAt: release.releasedAt,
      command: 'commands',
      ok: true,
      commands,
      globalOptions: GLOBAL_OPTIONS,
      defaultCommand: 'help',
      schema: 'devfleet fleet-nodes --schema --json',
      agent: agentGuide(release),
    },
    text: [
      `Personal command catalog · ${releaseLabel(release)}`,
      ...commands.map((entry) => `\n  ${entry.id}\n    ${entry.description}`),
      '\nUse personal <command> --help for options; personal --interactive opens the menu.',
    ].join('\n'),
  };
}

export async function execute(
  args: string[],
  defaults: Settings,
  version: string | Release
): Promise<CommandOutcome> {
  const release: Release =
    typeof version === 'string' ? { version, releasedAt: null } : version;
  let outcome: CommandOutcome | undefined;
  let output = '';
  const program = createProgram(release, (text) => {
    output += text;
  });
  const complete = (result: CommandOutcome) => {
    outcome = result;
  };
  registerFleet(program, defaults, complete);
  registerT3(program, defaults, complete);
  registerSourceOperations(program, defaults, complete);
  program
    .command('commands')
    .description('Search the command catalog and agent contract')
    .option('--search <text>', 'Filter names, descriptions and keywords')
    .option(
      '--group <name>',
      'Filter group: Fleet, T3, Infra, Workstation, Reference'
    )
    .action((_options, command: Command) => {
      outcome = catalog(command.optsWithGlobals<CliOptions>(), release);
    });
  program.action(() => {
    if (program.opts<CliOptions>().json)
      outcome = catalog(program.opts<CliOptions>(), release);
    else program.help();
  });
  try {
    await program.parseAsync(args, { from: 'user' });
    return (
      outcome ?? {
        exitCode: 0,
        data: { version: 1, help: output.trim() },
        text: output.trim(),
      }
    );
  } catch (error) {
    return commandError(error, output);
  }
}

function commandError(error: unknown, output: string): CommandOutcome {
  if (error instanceof CommanderError && error.exitCode === 0)
    return {
      exitCode: 0,
      data: { version: 1, help: output.trim() },
      text: output.trim(),
    };
  const usage =
    error instanceof CommanderError || error instanceof FleetUsageError;
  return {
    exitCode: usage ? 2 : 1,
    data: {
      version: 1,
      ok: false,
      code: usage ? 'invalid_usage' : 'operation_failed',
      error:
        error instanceof FleetUsageError
          ? error.message
          : usage
            ? 'Invalid command or option. Run personal --help or personal commands --json.'
            : 'Operation failed. Inspect configuration and permissions locally; raw errors are withheld to protect credentials.',
    },
  };
}
