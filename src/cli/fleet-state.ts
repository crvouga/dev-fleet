import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseDefinition } from '../definition';
import { FleetUsageError } from '../errors';
import { definitionSource } from '../fleet-config';
import { makeReport, renderReport, reportExitCode } from '../report';
import { runCommand } from '../runner';
import {
  describeBucket,
  parseBucket,
  readBucket,
  writeBucket,
  type Bucket,
} from '../state/bucket';
import { replicaCheck } from '../state/check';
import { adoptEarlier, legacyPath, readLegacy } from '../state/legacy';
import { bucketPath, databasePath, stateRoot } from '../state/paths';
import {
  DOCUMENTS,
  listDocuments,
  readDocument,
  writeDocument,
  type DocumentName,
} from '../state/store';
import {
  mutateState,
  pending,
  pull,
  push,
  standing,
  type Standing,
  type StateContext,
} from '../state/sync';
import type { Check, Runner } from '../types';
import type { CommandOutcome } from './contracts';

export interface FleetStateOptions {
  init?: boolean;
  bucket?: string;
  endpoint?: string;
  region?: string;
  prefix?: string;
  directory?: string;
  import?: string;
  export?: boolean;
  push?: boolean;
  restore?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
}

export interface FleetStateServices {
  run: Runner;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Asks for one hidden value on the terminal; null when there is none. */
  ask: ((question: string) => Promise<string>) | null;
}

function terminalAsk(
  options: FleetStateOptions
): FleetStateServices['ask'] | null {
  if (options.json || options.nonInteractive || process.env['CI']) return null;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  return async (question) => {
    const { password } = await import('@inquirer/prompts');
    return password({ message: question }, { output: process.stderr });
  };
}

function context(services: FleetStateServices): StateContext {
  return {
    root: stateRoot(services.env, services.home),
    bucket: readBucket(bucketPath(services.env, services.home)),
    run: services.run,
  };
}

const ACTIONS = ['init', 'import', 'export', 'push', 'restore'] as const;
type Action = (typeof ACTIONS)[number];

function action(options: FleetStateOptions): Action | 'status' {
  const chosen = ACTIONS.filter((name) => options[name]);
  if (chosen.length > 1)
    throw new FleetUsageError(
      'Choose one of --init, --import, --export, --push or --restore.'
    );
  const settings = ['bucket', 'endpoint', 'region', 'prefix', 'directory'];
  if (
    chosen[0] !== 'init' &&
    settings.some((name) => options[name as keyof FleetStateOptions])
  )
    throw new FleetUsageError(
      '--bucket, --endpoint, --region, --prefix and --directory belong to --init.'
    );
  return chosen[0] ?? 'status';
}

const TITLE: Record<DocumentName, string> = {
  definition: 'The fleet configuration',
  roster: 'The roster of enrolled workers',
  enrollment: 'The approved revision',
};

function definitionCheck(
  services: FleetStateServices,
  missing: 'fail' | 'warn'
): Check {
  const id = 'state:definition';
  const source = definitionSource(services.env, services.home);
  if (source.kind === 'file')
    return {
      id,
      status: 'pass',
      summary:
        'The fleet configuration is the file DEVFLEET_CONFIG names; it is kept outside the fleet state.',
    };
  if (existsSync(source.path))
    return {
      id,
      status: 'warn',
      summary: `The fleet configuration is only the copy fleet-sync installed at ${source.path}; the fleet state does not hold it.`,
      remedy: {
        action: `Store it: devfleet fleet-state --import ${source.path}.`,
      },
    };
  return {
    id,
    status: missing,
    summary: 'This machine has no fleet configuration.',
    remedy: {
      action:
        'Restore it from your bucket (devfleet fleet-state --init --bucket NAME --endpoint https://HOST), or start one: edit a copy of examples/fleet.json and run devfleet fleet-state --import PATH.',
    },
  };
}

function documentCheck(
  name: DocumentName,
  services: FleetStateServices,
  missing: 'fail' | 'warn'
): Check {
  const id = `state:${name}`;
  const stored = listDocuments(
    databasePath(stateRoot(services.env, services.home))
  ).find((document) => document.name === name);
  // A file named with DEVFLEET_CONFIG is what runs, whatever is stored.
  const named =
    name === 'definition' &&
    definitionSource(services.env, services.home).kind === 'file';
  if (stored && !named)
    return {
      id,
      status: 'pass',
      summary: `${TITLE[name]} is in the fleet state (changed ${stored.updatedAt}).`,
    };
  if (name === 'definition') return definitionCheck(services, missing);
  if (readLegacy(name, services.env, services.home) !== null)
    return {
      id,
      status: 'warn',
      summary: `${TITLE[name]} is still read from ${legacyPath(name, services.env, services.home)}, outside the fleet state.`,
      remedy: {
        action:
          'Move it into the fleet state: devfleet fleet-state --init. The next fleet-sync does the same. The file is left in place and no longer read afterwards.',
      },
    };
  return {
    id,
    status: 'skip',
    summary: `${TITLE[name]} is not recorded yet; fleet-sync records it.`,
  };
}

function bucketCheck(bucket: Bucket | null): Check {
  if (!bucket)
    return {
      id: 'state:bucket',
      status: 'warn',
      summary: 'No bucket is configured on this machine.',
      remedy: {
        action:
          'devfleet fleet-state --init --bucket NAME --endpoint https://HOST (docs/state.md lists the settings).',
      },
    };
  return {
    id: 'state:bucket',
    status: 'pass',
    summary:
      bucket.kind === 'directory'
        ? `The fleet state replicates to the directory ${bucket.path}.`
        : `The fleet state replicates to the bucket ${bucket.bucket} under ${bucket.prefix}/.`,
  };
}

function report(
  services: FleetStateServices,
  input: { standing: Standing; done?: string[]; missing?: 'warn' }
): CommandOutcome {
  const target = context(services);
  const checks = [
    bucketCheck(target.bucket),
    replicaCheck(input.standing),
    ...DOCUMENTS.map((name) =>
      documentCheck(name, services, input.missing ?? 'fail')
    ),
  ];
  const data = {
    ...makeReport('fleet-state', [{ node: 'state', checks }]),
    root: target.root,
    bucket: describeBucket(target.bucket),
    standing: input.standing,
    ...(input.done ? { done: input.done } : {}),
  };
  return {
    exitCode: reportExitCode(data, false),
    data,
    text: [...(input.done ?? []), renderReport(data)].join('\n'),
  };
}

async function credentials(
  services: FleetStateServices
): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
  const { env, ask } = services;
  const accessKeyId =
    env['DEVFLEET_BUCKET_ACCESS_KEY_ID'] ??
    (await ask?.(
      'Bucket access key ID (empty to use the AWS environment or profile)'
    ));
  if (!accessKeyId) return null;
  const secretAccessKey =
    env['DEVFLEET_BUCKET_SECRET_ACCESS_KEY'] ??
    (await ask?.('Bucket secret access key'));
  if (!secretAccessKey)
    throw new FleetUsageError(
      'A bucket access key ID needs its secret: set DEVFLEET_BUCKET_SECRET_ACCESS_KEY or answer the prompt. Credentials are never taken from arguments.'
    );
  return { accessKeyId, secretAccessKey };
}

/** The bucket named on the command line, or null to keep the saved one. */
async function namedBucket(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<Bucket | null> {
  const { bucket, endpoint, region, prefix, directory } = options;
  const s3 = { bucket, endpoint, region, prefix };
  const given = Object.values(s3).some((value) => value !== undefined);
  if (directory !== undefined && given)
    throw new FleetUsageError('Choose --directory or --bucket, not both.');
  if (directory !== undefined) return parseBucket({ directory });
  if (!given) return null;
  if (bucket === undefined)
    throw new FleetUsageError(
      '--endpoint, --region and --prefix need --bucket.'
    );
  return parseBucket({
    ...Object.fromEntries(
      Object.entries(s3).filter(([, value]) => value !== undefined)
    ),
    ...(await credentials(services)),
  });
}

async function init(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<CommandOutcome> {
  const done: string[] = [];
  const named = await namedBucket(options, services);
  if (named) {
    writeBucket(bucketPath(services.env, services.home), named);
    done.push(
      `Saved the bucket settings to ${bucketPath(services.env, services.home)}.`
    );
  }
  const target = context(services);
  const had = listDocuments(databasePath(target.root)).length > 0;
  const { value, standing: after } = await mutateState(target, (before) => {
    // A state the bucket already holds is the fleet's; this machine's
    // earlier files only ever seed an empty one.
    if (before === 'in-sync' || before === 'unreachable') return [];
    return adoptEarlier(services.env, services.home);
  });
  if (value.length)
    done.push(
      `Moved into the fleet state from this machine's earlier files: ${value.join(', ')}.`
    );
  else if (!had && listDocuments(databasePath(target.root)).length)
    done.push('Restored the fleet state from the bucket.');
  // Connecting a bucket that is still empty succeeded; storing a
  // configuration is the next step, not a failure of this one.
  return report(services, { standing: after, done, missing: 'warn' });
}

async function importDefinition(
  path: string,
  services: FleetStateServices
): Promise<CommandOutcome> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new FleetUsageError(
      '--import needs a readable JSON file such as an edited copy of examples/fleet.json.'
    );
  }
  const body = JSON.stringify(parseDefinition(value), null, 2) + '\n';
  const target = context(services);
  const { standing: after } = await mutateState(target, () => {
    adoptEarlier(services.env, services.home);
    return writeDocument(databasePath(target.root), 'definition', body);
  });
  return report(services, {
    standing: after,
    done: ['Stored the fleet configuration in the fleet state.'],
  });
}

function exportDefinition(services: FleetStateServices): CommandOutcome {
  const body = readDocument(
    databasePath(stateRoot(services.env, services.home)),
    'definition'
  );
  if (body === null)
    throw new FleetUsageError(
      'The fleet state holds no fleet configuration. Store one with devfleet fleet-state --import PATH.'
    );
  return {
    exitCode: 0,
    data: {
      version: 1,
      command: 'fleet-state',
      ok: true,
      definition: JSON.parse(body) as unknown,
    },
    text: body.trimEnd(),
  };
}

async function restore(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<CommandOutcome> {
  const target = context(services);
  if (!target.bucket)
    throw new FleetUsageError(
      'No bucket is configured, so there is nothing to restore from. Run devfleet fleet-state --init --bucket NAME --endpoint https://HOST.'
    );
  if (pending(target) && !options.yes)
    throw new FleetUsageError(
      'This machine has fleet state the bucket does not hold, and --restore discards it. Upload it with --push, or repeat with --yes to discard it.'
    );
  const after = await pull(target);
  return report(services, {
    standing: after,
    done:
      after === 'in-sync'
        ? ['This machine now holds the fleet state from the bucket.']
        : [],
  });
}

const DEFAULTS = (options: FleetStateOptions): FleetStateServices => ({
  run: runCommand,
  env: process.env,
  home: homedir(),
  ask: terminalAsk(options),
});

/** `fleet-state` alone is read-only. Each flag is one explicit action on the
 * manager's fleet state or its bucket.
 */
export async function fleetState(
  options: FleetStateOptions,
  services: FleetStateServices = DEFAULTS(options)
): Promise<CommandOutcome> {
  const chosen = action(options);
  if (chosen === 'init') return init(options, services);
  if (chosen === 'import') return importDefinition(options.import!, services);
  if (chosen === 'export') return exportDefinition(services);
  if (chosen === 'restore') return restore(options, services);
  const target = context(services);
  if (chosen === 'push')
    return report(services, { standing: await push(target) });
  return report(services, { standing: await standing(target) });
}
