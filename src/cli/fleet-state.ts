import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDefinition } from '../definition';
import { FleetUsageError } from '../errors';
import { definitionSource } from '../fleet-config';
import { PACKAGE_ROOT, packageInfo } from '../package-info';
import { makeReport, renderReport, reportExitCode } from '../report';
import { runCommand } from '../runner';
import {
  ACCESS_KEY_ID_ENV,
  SECRET_ACCESS_KEY_ENV,
  bucketIdentity,
  describeBucket,
  parseBucket,
  withCredentials,
  writeBucket,
  type Bucket,
} from '../state/bucket';
import { replicaCheck } from '../state/check';
import {
  connection,
  environmentCredentials,
  type Connection,
} from '../state/connection';
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
  example?: boolean;
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

const reach = (services: FleetStateServices): Connection =>
  connection(services.env, services.home);

function context(services: FleetStateServices): StateContext {
  return {
    root: stateRoot(services.env, services.home),
    bucket: reach(services).bucket,
    run: services.run,
  };
}

const ACTIONS = [
  'init',
  'import',
  'export',
  'example',
  'push',
  'restore',
] as const;
type Action = (typeof ACTIONS)[number];

function action(options: FleetStateOptions): Action | 'status' {
  const chosen = ACTIONS.filter((name) => options[name]);
  if (chosen.length > 1)
    throw new FleetUsageError(
      'Choose one of --init, --import, --export, --example, --push or --restore.'
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
  if (source.kind === 'file' && existsSync(source.path))
    return {
      id,
      status: 'pass',
      summary: `The fleet configuration is ${source.path}. fleet-sync records the one it applies in the fleet state, for runs started anywhere else.`,
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
        'Run devfleet from the project that holds your fleet.json; devfleet fleet-state --example prints one to start from. A bucket that already holds a configuration restores it: devfleet fleet-state --init --bucket NAME --endpoint https://HOST.',
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
  // The project's file is what runs, whatever is stored.
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

const CREDENTIALS: Record<NonNullable<Connection['credentials']>, string> = {
  environment: `the credentials in ${ACCESS_KEY_ID_ENV} and ${SECRET_ACCESS_KEY_ENV}`,
  saved: 'the credentials saved in bucket.json on this machine',
  ambient: 'the standard AWS environment or profile',
};

function bucketCheck({ bucket, location, credentials }: Connection): Check {
  if (!bucket)
    return {
      id: 'state:bucket',
      status: 'warn',
      summary: 'No bucket is configured.',
      remedy: {
        action: `Name it under "state" in fleet.json and pass its credentials in ${ACCESS_KEY_ID_ENV} and ${SECRET_ACCESS_KEY_ENV}. Without a fleet.json, connect one on this machine: devfleet fleet-state --init --bucket NAME --endpoint https://HOST (docs/state.md lists the settings).`,
      },
    };
  const named =
    location === 'configuration'
      ? 'named in the fleet configuration'
      : 'saved in bucket.json on this machine';
  return {
    id: 'state:bucket',
    status: 'pass',
    summary:
      bucket.kind === 'directory'
        ? `The fleet state replicates to the directory ${bucket.path} (${named}).`
        : `The fleet state replicates to the bucket ${bucket.bucket} under ${bucket.prefix}/ (${named}), with ${CREDENTIALS[credentials ?? 'ambient']}.`,
  };
}

/** What a report may say about the connection: never a credential. */
function describeConnection(reached: Connection): Record<string, unknown> {
  return {
    ...describeBucket(reached.bucket),
    ...(reached.location
      ? {
          location:
            reached.location === 'configuration' ? 'fleet.json' : 'bucket.json',
        }
      : {}),
    ...(reached.credentials
      ? {
          credentials: {
            environment: 'environment',
            saved: 'bucket.json',
            ambient: 'aws',
          }[reached.credentials],
        }
      : {}),
  };
}

function report(
  services: FleetStateServices,
  input: { standing: Standing; done?: string[]; missing?: 'warn' }
): CommandOutcome {
  const reached = reach(services);
  const checks = [
    bucketCheck(reached),
    replicaCheck(input.standing),
    ...DOCUMENTS.map((name) =>
      documentCheck(name, services, input.missing ?? 'fail')
    ),
  ];
  const data = {
    ...makeReport('fleet-state', [{ node: 'state', checks }]),
    root: stateRoot(services.env, services.home),
    bucket: describeConnection(reached),
    standing: input.standing,
    ...(input.done ? { done: input.done } : {}),
  };
  return {
    exitCode: reportExitCode(data, false),
    data,
    text: [...(input.done ?? []), renderReport(data)].join('\n'),
  };
}

/** The credentials for a bucket being saved: the ones passed to this
 * command, or the answers to a prompt. Null to use the standard AWS
 * environment or profile.
 */
async function credentials(
  services: FleetStateServices
): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
  const { env, ask } = services;
  const given = environmentCredentials(env);
  if (given) return given;
  const accessKeyId = await ask?.(
    'Bucket access key ID (empty to use the AWS environment or profile)'
  );
  if (!accessKeyId) return null;
  const secretAccessKey = await ask?.('Bucket secret access key');
  if (!secretAccessKey)
    throw new FleetUsageError(
      `A bucket access key ID needs its secret: set ${SECRET_ACCESS_KEY_ENV} or answer the prompt. Credentials are never taken from arguments.`
    );
  return { accessKeyId, secretAccessKey };
}

/** The bucket named on the command line, or null when none is. */
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

/** The bucket the fleet configuration names, with credentials to save beside
 * it so that runs this machine starts by itself (the schedule, a hand-off
 * from a worker) reach it too. Null when there is nothing new to save: the
 * configuration names no bucket, or names a directory, or this machine
 * already holds credentials for it and none were passed.
 */
async function declaredBucket(
  services: FleetStateServices
): Promise<Bucket | null> {
  const reached = reach(services);
  const { bucket } = reached;
  if (reached.location !== 'configuration' || bucket?.kind !== 's3')
    return null;
  if (reached.credentials === 'saved') return null;
  const given = await credentials(services);
  return given ? withCredentials(bucket, given) : null;
}

/** What `--init` saves on this machine, or null to keep what is there. */
async function bucketToSave(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<Bucket | null> {
  const named = await namedBucket(options, services);
  const reached = reach(services);
  if (!named) return declaredBucket(services);
  if (
    reached.location === 'configuration' &&
    reached.bucket &&
    bucketIdentity(reached.bucket) !== bucketIdentity(named)
  )
    throw new FleetUsageError(
      'The fleet configuration names another bucket under "state". Change it there, or run --init without --bucket, --endpoint, --region, --prefix and --directory to connect that one.'
    );
  return named;
}

async function init(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<CommandOutcome> {
  const done: string[] = [];
  const saved = await bucketToSave(options, services);
  if (saved) {
    writeBucket(bucketPath(services.env, services.home), saved);
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
      '--import needs a readable JSON file: a fleet.json such as the one devfleet fleet-state --example prints.'
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

/** A configuration to start a project from: the packaged example, with its
 * schema named where an installed dev-fleet keeps it.
 */
async function exampleDefinition(): Promise<CommandOutcome> {
  const example = JSON.parse(
    await readFile(join(PACKAGE_ROOT, 'examples/fleet.json'), 'utf8')
  ) as Record<string, unknown>;
  const definition = {
    ...example,
    $schema: `./node_modules/${packageInfo().name}/schema/fleet.schema.json`,
  };
  return {
    exitCode: 0,
    data: { version: 1, command: 'fleet-state', ok: true, definition },
    text: JSON.stringify(definition, null, 2),
  };
}

async function restore(
  options: FleetStateOptions,
  services: FleetStateServices
): Promise<CommandOutcome> {
  const target = context(services);
  if (!target.bucket)
    throw new FleetUsageError(
      'No bucket is configured, so there is nothing to restore from. Name it under "state" in fleet.json, or run devfleet fleet-state --init --bucket NAME --endpoint https://HOST.'
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
  if (chosen === 'example') return exampleDefinition();
  if (chosen === 'restore') return restore(options, services);
  const target = context(services);
  if (chosen === 'push')
    return report(services, { standing: await push(target) });
  return report(services, { standing: await standing(target) });
}
