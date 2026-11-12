import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { record } from './config';
import { DefinitionError, HOST_KEY } from './definition';

/** One worker as an infrastructure tool describes it, without naming the
 * tool or the provider: schema/worker-record.schema.json. A file or command
 * `workerRecords` in fleet.json names returns a list of them; dev-fleet only
 * reads it and never creates a machine.
 */
export interface WorkerRecord {
  id: string;
  /** The tailnet name the worker joins under; preferred to `address`. */
  tailnetName?: string;
  /** An address SSH reaches the worker at, when it has no tailnet name. */
  address?: string;
  user: string;
  /** The port sshd listens on; 22 when absent. */
  port?: number;
  /** The SSH host public key, "TYPE BASE64": pinned, never learned.
   * Without one the key is the one the fleet state pins (fleet-node-seed
   * --apply --yes), and until then every session is refused.
   */
  hostKey?: string;
  /** The port the worker's T3 server listens on; 3773 when absent. */
  t3Port?: number;
  labels?: Record<string, string>;
  billing?: { hourlyRate: number; currency?: string; note?: string };
}

/** Where `workerRecords` reads records from. */
export type RecordSource = { file: string } | { command: string[] };

/** Runs a record command in the project directory; its standard output. */
export type RecordCommand = (
  argv: string[],
  directory: string
) => string | null;

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const HOST = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const RECORD_FIELDS = [
  'id',
  'tailnetName',
  'address',
  'user',
  'port',
  'hostKey',
  't3Port',
  'labels',
  'billing',
];
/** Port of the worker T3 server when a record names none. */
const T3_PORT = 3773;

function invalid(
  path: string,
  expected: string,
  actual: unknown,
  code = actual === undefined ? 'DEFINITION_MISSING' : 'DEFINITION_INVALID'
): never {
  throw new DefinitionError({
    code,
    path,
    expected,
    actual:
      actual === undefined
        ? 'nothing'
        : Array.isArray(actual)
          ? `an array of ${actual.length}`
          : record(actual)
            ? 'an object'
            : JSON.stringify(actual).slice(0, 64),
  });
}

function string(
  value: unknown,
  pattern: RegExp,
  path: string,
  expected: string
): string {
  if (typeof value !== 'string' || !pattern.test(value))
    invalid(path, expected, value);
  return value as string;
}

function port(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
    invalid(path, 'a port from 1 to 65535', value);
  return value as number;
}

/** One record, or a DefinitionError naming the field that is wrong. */
export function parseRecord(value: unknown, path: string): WorkerRecord {
  if (!record(value)) return invalid(path, 'an object', value);
  const unknown = Object.keys(value).find(
    (key) => !RECORD_FIELDS.includes(key)
  );
  if (unknown !== undefined)
    invalid(
      `${path}.${unknown}`,
      `one of ${RECORD_FIELDS.join(', ')}`,
      value[unknown],
      'DEFINITION_UNKNOWN'
    );
  const id = string(value['id'], ID, `${path}.id`, 'a lowercase id');
  if (value['tailnetName'] === undefined && value['address'] === undefined)
    invalid(`${path}.tailnetName`, 'a tailnet name, or an address', undefined);
  return {
    id,
    ...(value['tailnetName'] === undefined
      ? {}
      : {
          tailnetName: string(
            value['tailnetName'],
            HOST,
            `${path}.tailnetName`,
            'a host name'
          ),
        }),
    ...(value['address'] === undefined
      ? {}
      : {
          address: string(
            value['address'],
            HOST,
            `${path}.address`,
            'a host name or IP address'
          ),
        }),
    user: string(value['user'], USER, `${path}.user`, 'a login name'),
    ...(value['port'] === undefined
      ? {}
      : { port: port(value['port'], `${path}.port`) }),
    ...(value['hostKey'] === undefined
      ? {}
      : {
          hostKey: string(
            value['hostKey'],
            HOST_KEY,
            `${path}.hostKey`,
            'one SSH public key, "TYPE BASE64"'
          ),
        }),
    ...(value['t3Port'] === undefined
      ? {}
      : { t3Port: port(value['t3Port'], `${path}.t3Port`) }),
    ...(value['labels'] === undefined
      ? {}
      : { labels: value['labels'] as Record<string, string> }),
    ...(value['billing'] === undefined
      ? {}
      : { billing: value['billing'] as WorkerRecord['billing'] & object }),
  };
}

/** A record list: `{ "version": 1, "workers": [...] }`. */
export function parseRecords(value: unknown, path: string): WorkerRecord[] {
  if (!record(value)) return invalid(path, 'an object', value);
  if (value['version'] !== 1) invalid(`${path}.version`, '1', value['version']);
  const workers = value['workers'];
  if (!Array.isArray(workers) || workers.length > 64)
    return invalid(
      `${path}.workers`,
      'an array of at most 64 records',
      workers
    );
  return workers.map((entry, index) =>
    parseRecord(entry, `${path}.workers[${index}]`)
  );
}

/** The worker a record declares, as fleet.json would write it. Labels and
 * billing are checked by the definition itself.
 */
export function recordWorker(entry: WorkerRecord): Record<string, unknown> {
  return {
    id: entry.id,
    os: 'linux',
    network: {
      tailscaleName: entry.tailnetName ?? entry.address,
      user: entry.user,
      sshPort: entry.port ?? 22,
      t3Port: entry.t3Port ?? T3_PORT,
      ...(entry.hostKey ? { hostKey: entry.hostKey } : {}),
    },
    ...(entry.labels ? { labels: entry.labels } : {}),
    ...(entry.billing ? { billing: entry.billing } : {}),
    origin: 'records',
  };
}

function source(value: unknown, path: string): RecordSource {
  if (record(value) && typeof value['file'] === 'string' && !value['command'])
    return { file: value['file'] };
  if (
    record(value) &&
    Array.isArray(value['command']) &&
    value['command'].length > 0 &&
    value['command'].every((entry) => typeof entry === 'string') &&
    value['file'] === undefined
  )
    return { command: value['command'] as string[] };
  return invalid(path, '{ "file": PATH } or { "command": [ARGV] }', value);
}

/** Runs a record command where fleet.json is, for at most a minute. */
export const runRecordCommand: RecordCommand = (argv, directory) => {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout : null;
};

function readSource(
  entry: RecordSource,
  path: string,
  directory: string,
  command: RecordCommand
): unknown {
  let text: string | null;
  if ('file' in entry) {
    try {
      text = readFileSync(
        isAbsolute(entry.file) ? entry.file : join(directory, entry.file),
        'utf8'
      );
    } catch (error) {
      // The tool that writes the file removes it with the last machine
      // (`tofu destroy`): no file is no record.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, workers: [] };
      text = null;
    }
  } else text = command(entry.command, directory);
  if (text === null)
    invalid(
      `${path}.${'file' in entry ? 'file' : 'command'}`,
      'a readable list of worker records',
      'nothing',
      'DEFINITION_UNREADABLE'
    );
  try {
    return JSON.parse(text!) as unknown;
  } catch {
    return invalid(
      path,
      'JSON',
      'text that is not JSON',
      'DEFINITION_UNREADABLE'
    );
  }
}

/** fleet.json with the workers its record sources return appended to the
 * inline list, and `workerRecords` itself gone: what the rest of dev-fleet
 * reads, installs and stores. A record whose ID is already declared is
 * refused, naming the record.
 */
export function expandRecords(
  value: unknown,
  directory: string,
  command: RecordCommand = runRecordCommand
): unknown {
  if (!record(value) || value['workerRecords'] === undefined) return value;
  const { workerRecords, ...rest } = value;
  if (!Array.isArray(workerRecords) || workerRecords.length > 8)
    return invalid(
      '$.workerRecords',
      'a list of at most 8 record sources',
      workerRecords
    );
  const inline = Array.isArray(rest['workers']) ? rest['workers'] : [];
  const seen = new Set(
    inline.map((entry) => (record(entry) ? entry['id'] : undefined))
  );
  const added: Record<string, unknown>[] = [];
  workerRecords.forEach((raw, index) => {
    const path = `$.workerRecords[${index}]`;
    const entry = source(raw, path);
    const records = parseRecords(
      readSource(entry, path, directory, command),
      path
    );
    records.forEach((found, position) => {
      if (seen.has(found.id))
        invalid(
          `${path}.workers[${position}].id`,
          'an id no other worker has',
          found.id,
          'DEFINITION_DUPLICATE'
        );
      seen.add(found.id);
      added.push(recordWorker(found));
    });
  });
  return { ...rest, workers: [...inline, ...added] };
}
