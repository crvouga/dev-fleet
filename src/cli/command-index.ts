import { SOURCE_OPERATIONS } from './source-operations';
import { commandCatalog } from './registry';
import type { CommandSpec } from './contracts';

const APPLIES = new Set(['fleet-node-sync', 't3-apply', 't3-cleanup']);

/** Additive machine-readable discovery; the registry also drives the menu. */
export function indexedCommands(search = '', group?: string) {
  return commandCatalog(search, group).map((entry) => ({
    ...entry,
    help: `devfleet ${entry.args.join(' ')} --help`,
    execution: execution(entry),
  }));
}

function execution(entry: CommandSpec) {
  if (Object.hasOwn(SOURCE_OPERATIONS, entry.id))
    return {
      default: 'depends-on-subcommand',
      authorization: 'owner-specific; inspect leaf help before invocation',
      requirements: ['dev-fleet checkout and its toolchain'],
      note: 'Streams the owner protocol. JSON and mutation flags depend on the leaf operation.',
    };
  if (entry.id === 'fleet-sync')
    return {
      default: 'interactive-confirmation-or-action-required',
      authorization: 'interactive-confirmation or --apply --yes',
      preview: 'devfleet fleet-sync --dry-run --json',
      scope:
        'enrolled Ubuntu fleet over verified SSH; manager is not an implicit target',
      note: 'JSON/noninteractive never prompt. Full Ubuntu acceptance is not yet implemented.',
    };
  if (entry.mutation && entry.id.startsWith('fleet-state '))
    return {
      default: 'apply',
      authorization: 'command-invocation',
      preview: 'devfleet fleet-state --json',
      note: 'Each flag is one explicit action on this manager’s fleet state. JSON selects output format; it does not prevent writes.',
    };
  if (APPLIES.has(entry.id))
    return {
      default: 'apply',
      authorization: 'command-invocation',
      preview: `devfleet ${entry.id} --dry-run --json`,
      note:
        entry.id === 't3-apply'
          ? '--import ID adopts an existing instance without reconciling. JSON selects output format; it does not prevent writes.'
          : 'JSON selects output format; it does not prevent writes.',
    };
  if (entry.mutation)
    return {
      default: 'preview',
      authorization: '--apply --yes',
      note: 'Supply required options shown by command --help. A preview does not apply changes.',
    };
  return { default: 'read-only', authorization: 'none' };
}
