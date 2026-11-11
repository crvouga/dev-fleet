import { CAPABILITIES } from '../config';
import { FleetUsageError } from '../errors';
import type { Capability } from '../types';
import type { Settings } from './settings';

export interface CliOptions extends Partial<Settings> {
  managed?: boolean;
  workers?: boolean;
  tailnet?: boolean;
  list?: boolean;
  onboard?: boolean;
  schema?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  interactive?: boolean;
  local?: boolean;
  all?: boolean;
  node?: string[];
  require?: string;
  timeout?: string;
  strict?: boolean;
  repair?: string;
  script?: boolean;
  planHash?: string;
  apply?: boolean;
  yes?: boolean;
  id?: string;
  ssh?: string;
  path?: string;
  runtime?: string;
  search?: string;
  group?: string;
}

export function capabilities(value?: string): Capability[] {
  const values =
    value === 'none'
      ? []
      : (value?.split(',') ??
        CAPABILITIES.filter((entry) => entry !== 'worker'));
  if (values.some((entry) => !CAPABILITIES.includes(entry as Capability)))
    throw new FleetUsageError(
      `--require expects ${CAPABILITIES.join(',')} or none.`
    );
  return [...new Set(values)] as Capability[];
}

export function timeout(options: CliOptions): number {
  const value = Number(
    options.timeout ?? (options.apply ? 1_500_000 : 120_000)
  );
  if (!Number.isInteger(value) || value < 1000 || value > 1_800_000)
    throw new FleetUsageError('--timeout must be 1000–1800000 milliseconds.');
  return value;
}

/** Validation runs on the internal action selected by fleet-* flags. */
export function validateOptions(command: string, options: CliOptions): void {
  if (options.tailnet && options.workers)
    throw new FleetUsageError('Choose --tailnet or --workers, not both.');
  if (options.onboard && options.schema)
    throw new FleetUsageError('Choose --onboard or --schema, not both.');
  validateMutation(command, options);
  validateRepair(command, options);
  validateScope(command, options);
  if (
    (['discover', 'health'].includes(command) ||
      (command === 'repair' && !options.local)) &&
    options.require !== undefined
  )
    throw new FleetUsageError(
      '--require is supported for roster status and local repair only; tailnet checks use declared roster requirements.'
    );
  if (options.timeout !== undefined) timeout(options);
}

function validateMutation(command: string, options: CliOptions): void {
  if (options.apply && !['add', 'repair'].includes(command))
    throw new FleetUsageError(
      '--apply is only valid for fleet-node-add and fleet-repair.'
    );
  if (options.apply && !options.yes)
    throw new FleetUsageError('Mutation requires both --apply and --yes.');
}

function validateScope(command: string, options: CliOptions): void {
  const selected = [options.local, options.all, options.node?.length].filter(
    Boolean
  );
  if (['discover', 'health'].includes(command) && selected.length)
    throw new FleetUsageError(
      'Tailscale discovery, --tailnet and --workers always cover all visible computers; --local, --all and --node are not supported.'
    );
  if (selected.length > 1)
    throw new FleetUsageError(
      'Choose --local, --all, or --node, not a combination.'
    );
  validateRosterScope(command, options);
}

function validateRosterScope(command: string, options: CliOptions): void {
  if ((options.local || options.all) && !['doctor', 'repair'].includes(command))
    throw new FleetUsageError(
      '--local and --all are only valid for fleet-status and fleet-repair.'
    );
}

function validateRepair(command: string, options: CliOptions): void {
  if (
    options.planHash !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.planHash)
  )
    throw new FleetUsageError(
      '--plan-hash expects the SHA-256 value from a repair preview.'
    );
  const repairFlags =
    options.repair !== undefined ||
    options.script === true ||
    options.planHash !== undefined;
  if (repairFlags && command !== 'repair')
    throw new FleetUsageError(
      '--repair, --script and --plan-hash are only valid for fleet-repair without --list.'
    );
  if (options.script && options.apply)
    throw new FleetUsageError(
      '--script only generates a preview; run a reviewed repair separately with --apply --yes.'
    );
  validateCatalog(command, options);
}

function validateCatalog(command: string, options: CliOptions): void {
  const filtered =
    options.local ||
    options.all ||
    Boolean(options.node?.length) ||
    options.require !== undefined;
  if (command === 'repairs' && filtered)
    throw new FleetUsageError(
      'fleet-repair --list is a static catalog and does not accept target or capability filters.'
    );
}
