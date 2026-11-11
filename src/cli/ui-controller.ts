import type { InteractiveOptions } from './contracts';
import { runCommand } from './ui-actions';
import { clean, commandChoices, isCancellation } from './ui-data';
import { addNode } from './ui-wizard';
import type { Choice, Display, Prompts, Session } from './ui-types';

export async function runInteractive(
  options: InteractiveOptions,
  prompts: Prompts,
  display: Display
): Promise<void> {
  const session: Session = { options, prompts, display };
  showHeader(session);
  let running = true;
  while (running) {
    try {
      const choice = await prompts.search(
        'Command palette · type to search · arrows + enter',
        (term) => paletteChoices(session, term)
      );
      running = await dispatch(session, choice);
    } catch (error) {
      if (isCancellation(error)) {
        display.write('\nGoodbye. No further actions will run.');
        throw error;
      }
      display.write(
        'The interactive session could not continue safely. Use personal commands --json for noninteractive help.'
      );
      throw new Error('Interactive session failed safely.');
    }
  }
  display.write('Goodbye. Session context was not saved.');
}

function showHeader(session: Session): void {
  session.display.panel(
    `personal · ${clean(session.options.version)} · ${session.options.releasedAt ? `released ${clean(session.options.releasedAt)}` : 'unreleased source build'}`,
    [
      'Your developer fleet, without the guesswork.',
      `Workspace: ${clean(session.workspace ?? session.options.workspace)}`,
      `Config: ${clean(session.config ?? session.options.config)}`,
      'Read-only first · explicit writes · no automatic repairs',
      'Search IDs, keywords or descriptions. Ctrl+C exits safely. Nothing is cleared.',
    ].join('\n')
  );
}

export function paletteChoices(session: Session, term: string): Choice[] {
  const commands = commandChoices(session.options.commands, term);
  const navigation = [
    {
      name: 'Session: Workspace / config…',
      value: 'context',
      description: 'Session-only overrides; no hidden configuration writes.',
    },
    { name: 'Exit', value: 'exit', description: 'Close the command palette.' },
  ].filter((choice) =>
    `${choice.name} ${choice.description}`
      .toLowerCase()
      .includes(term.toLowerCase().trim())
  );
  const choices = [...navigation, ...commands].sort((a, b) =>
    a.name.localeCompare(b.name, 'en')
  );
  return choices.length
    ? choices
    : [{ name: 'No matching commands — change search', value: 'none' }];
}

async function dispatch(session: Session, choice: string): Promise<boolean> {
  if (choice === 'exit') return false;
  if (choice === 'context') await changeContext(session);
  if (choice.startsWith('command:'))
    await openCommand(session, choice.slice(8));
  return true;
}

async function openCommand(session: Session, id: string): Promise<void> {
  const command = session.options.commands.find((entry) => entry.id === id);
  if (!command) return;
  if (command.id === 'fleet-node-add') await addNode(session);
  else await runCommand(session, command);
}

async function changeContext(session: Session): Promise<void> {
  session.display.write(
    'Session only. Blank inputs reset to startup defaults; no file is written.'
  );
  const workspace = await session.prompts.input(
    'Workspace override',
    session.workspace ?? '',
    validContext
  );
  const config = await session.prompts.input(
    'Config override',
    session.config ?? '',
    validContext
  );
  if (workspace) session.workspace = workspace;
  else delete session.workspace;
  if (config) session.config = config;
  else delete session.config;
  showHeader(session);
}

function validContext(value: string): boolean | string {
  return (
    !/[\x00-\x1f\x7f]/.test(value) ||
    'Control characters are not allowed in paths.'
  );
}
