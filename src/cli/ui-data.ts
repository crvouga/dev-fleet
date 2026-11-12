import type { CommandSpec } from './contracts';
import type { CheckRow, Choice, Session } from './ui-types';
import { searchCommands } from './search';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clean(value: string, limit = 2000): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, limit);
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? clean(value) : fallback;
}

export function quote(value: string): string {
  return /^[a-zA-Z0-9_./:=,@-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function callArgs(session: Session, args: string[]): string[] {
  return [
    ...args,
    ...(session.workspace ? ['--workspace', session.workspace] : []),
    ...(session.config ? ['--config', session.config] : []),
  ];
}

export function reproduction(session: Session, args: string[]): string {
  return [
    'personal',
    ...args,
    '--workspace',
    session.workspace ?? session.options.workspace,
    '--config',
    session.config ?? session.options.config,
    '--json',
  ]
    .map(quote)
    .join(' ');
}

export function commandChoices(
  commands: CommandSpec[],
  term: string
): Choice[] {
  return searchCommands(commands, term).map((command) => ({
    name: `${clean(command.group)}: ${clean(command.title)}`,
    value: `command:${command.id}`,
    description: `${clean(command.description)}${command.mutation ? ' · confirmation required' : ''}`,
  }));
}

export function reportChecks(data: unknown): CheckRow[] {
  if (!record(data)) return [];
  const nodes = Array.isArray(data['nodes']) ? data['nodes'] : [];
  return [
    ...nodes.flatMap(nodeChecks),
    ...nodeChecks({ node: 'tailscale', checks: data['checks'] }),
  ];
}

function nodeChecks(value: unknown): CheckRow[] {
  if (!record(value) || !Array.isArray(value['checks'])) return [];
  const node = text(value['node'], 'manager');
  return value['checks'].flatMap((check: unknown) => {
    if (!record(check) || !isStatus(check['status'])) return [];
    const remedy = record(check['remedy']) ? check['remedy'] : {};
    return [
      {
        node,
        id: text(check['id'], 'check'),
        status: check['status'],
        summary: text(check['summary']),
        remedy: text(remedy['action']),
        command: text(remedy['command']),
      },
    ];
  });
}

export function isStatus(value: unknown): value is string {
  return ['pass', 'warn', 'fail', 'skip', 'not-applicable'].includes(
    String(value)
  );
}

export function isCancellation(error: unknown): boolean {
  if (!record(error)) return false;
  return ['ExitPromptError', 'AbortPromptError', 'AbortError'].includes(
    text(error['name'])
  );
}

export function absolutePath(value: string): boolean | string {
  return (
    (value.startsWith('/') &&
      value.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(value)) ||
    'Enter an absolute POSIX path (no ~ or control characters).'
  );
}
