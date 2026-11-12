import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fleet, secret } from '../fleet-config';
import {
  deliver,
  observe,
  parseMemory,
  transitions,
  type Notification,
  type NotifyConfig,
} from '../notify';
import { connection } from '../state/connection';
import type { Bucket } from '../state/bucket';
import type { SecretsProvider } from '../secrets';
import type { Check, NodeReport } from '../types';
import type { CommandOutcome } from './contracts';

export interface FleetWatchOptions {
  test?: boolean;
}

/** What the watcher remembers between runs, kept in the bucket beside the
 * fleet state. Its time is the heartbeat an off-machine check reads.
 */
export interface WatchStore {
  read: () => Promise<string | null>;
  write: (text: string) => Promise<void>;
}

export interface FleetWatchServices {
  notify: NotifyConfig | undefined;
  /** The machines as `fleet-status --workers` sees them now. */
  status: () => Promise<NodeReport[]>;
  store: WatchStore | null;
  secrets: SecretsProvider;
  send: typeof fetch;
  now: () => Date;
  /** Parks the workers `worker:idle` warns about; only when fleet.json turns
   * parking.autoPark on. One check per worker it parked or could not.
   */
  autoPark?: (reports: NodeReport[]) => Promise<Check[]>;
}

/** Compares the fleet's health with the previous run and notifies on
 * transitions only. `--test` sends one test notification and nothing else.
 */
export async function fleetWatch(
  options: FleetWatchOptions,
  services: FleetWatchServices
): Promise<CommandOutcome> {
  const { notify } = services;
  if (options.test) {
    const checks = notify
      ? await deliver(
          notify,
          { event: 'test', node: 'fleet-watch', checks: [] },
          services.secrets,
          services.send
        )
      : [unconfigured('fail')];
    return outcome(checks, [
      { event: 'test', node: 'fleet-watch', checks: [] },
    ]);
  }
  const previous = services.store
    ? parseMemory(await services.store.read().catch(() => null))
    : null;
  const reports = await services.status();
  const observed = observe(reports);
  const { notifications, memory } = transitions(
    previous,
    observed,
    services.now(),
    notify?.repeatHours ?? 0
  );
  const checks: Check[] = [];
  for (const notification of notifications)
    if (notify)
      checks.push(
        ...(await deliver(
          notify,
          notification,
          services.secrets,
          services.send
        ))
      );
  if (!notify) checks.push(unconfigured('warn'));
  if (services.autoPark) checks.push(...(await services.autoPark(reports)));
  checks.push(await heartbeat(services.store, JSON.stringify(memory)));
  return outcome(checks, notifications);
}

function unconfigured(status: 'warn' | 'fail'): Check {
  return {
    id: 'notify:configured',
    status,
    summary: 'NOTIFY_NOT_CONFIGURED',
    remedy: {
      action:
        'Add a "notify" block to fleet.json with its targets, and store each target address as its secret (notify-webhook-url, notify-ntfy-url).',
    },
  };
}

async function heartbeat(
  store: WatchStore | null,
  text: string
): Promise<Check> {
  const id = 'watch:heartbeat';
  if (!store)
    return {
      id,
      status: 'warn',
      summary: 'WATCH_HEARTBEAT_NO_BUCKET',
      remedy: {
        action:
          'Name the bucket under "state" in fleet.json: the heartbeat and what the watcher remembers are kept there.',
      },
    };
  return store.write(text).then(
    () => ({
      id,
      status: 'pass' as const,
      summary: 'The heartbeat and the health of each machine were stored.',
    }),
    () => ({
      id,
      status: 'fail' as const,
      summary: 'WATCH_HEARTBEAT_UNWRITTEN',
      remedy: {
        action:
          'Check the bucket credentials this run was given (devfleet fleet-state shows the connection).',
      },
    })
  );
}

function outcome(
  checks: Check[],
  notifications: Notification[]
): CommandOutcome {
  const ok = !checks.some((check) => check.status === 'fail');
  const lines = [
    ...notifications.map(
      (entry) =>
        `${entry.event} ${entry.node}${entry.checks.length ? `: ${entry.checks.join(', ')}` : ''}`
    ),
    ...checks.map((check) => `${check.status} ${check.id} ${check.summary}`),
  ];
  return {
    exitCode: ok ? 0 : 1,
    data: { version: 1, command: 'fleet-watch', ok, notifications, checks },
    text: lines.join('\n') || 'Nothing changed.',
  };
}

/** The watcher's object in the bucket, beside the fleet state. */
export const WATCH_OBJECT = 'watch.json';

export function bucketStore(bucket: Bucket | null): WatchStore | null {
  if (!bucket) return null;
  if (bucket.kind === 'directory') {
    const path = join(bucket.path, WATCH_OBJECT);
    return {
      read: () => readFile(path, 'utf8').catch(() => null),
      write: async (text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, { mode: 0o600 });
      },
    };
  }
  const client = new Bun.S3Client({
    bucket: bucket.bucket,
    ...(bucket.endpoint ? { endpoint: bucket.endpoint } : {}),
    ...(bucket.region ? { region: bucket.region } : {}),
    ...(bucket.accessKeyId && bucket.secretAccessKey
      ? {
          accessKeyId: bucket.accessKeyId,
          secretAccessKey: bucket.secretAccessKey,
        }
      : {}),
  });
  const file = client.file(`${bucket.prefix}/${WATCH_OBJECT}`);
  return {
    read: async () => ((await file.exists()) ? file.text() : null),
    write: async (text) => {
      await file.write(text, { type: 'application/json' });
    },
  };
}

/** The services of a real run, on the manager. */
export function watchServices(
  status: () => Promise<NodeReport[]>
): FleetWatchServices {
  return {
    notify: fleet.notify,
    status,
    store: bucketStore(connection().bucket),
    secrets: secret,
    send: fetch,
    now: () => new Date(),
  };
}
