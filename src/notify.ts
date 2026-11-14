import { record } from './config';
import type { SecretName, SecretsProvider } from './secrets';
import type { Check, NodeReport } from './types';

/** Where fleet-watch sends a notification. The address of each target is a
 * secret, read by purpose: a webhook or ntfy URL often carries its own token.
 */
export const NOTIFY_TARGETS = {
  webhook: 'notify-webhook-url',
  ntfy: 'notify-ntfy-url',
} as const satisfies Record<string, SecretName>;
export type NotifyTarget = keyof typeof NOTIFY_TARGETS;

export interface NotifyConfig {
  targets: NotifyTarget[];
  /** Notify again about a machine that stays unhealthy this often; 0 never. */
  repeatHours: number;
}

const DEFAULT_REPEAT_HOURS = 24;

/** The `notify` block of a fleet configuration, or null when it is invalid. */
export function parseNotify(value: unknown): NotifyConfig | null {
  if (!record(value)) return null;
  if (
    Object.keys(value).some((key) => !['targets', 'repeatHours'].includes(key))
  )
    return null;
  const { targets, repeatHours = DEFAULT_REPEAT_HOURS } = value;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    !targets.every(
      (target) =>
        typeof target === 'string' && Object.hasOwn(NOTIFY_TARGETS, target)
    ) ||
    typeof repeatHours !== 'number' ||
    !Number.isInteger(repeatHours) ||
    repeatHours < 0 ||
    repeatHours > 720
  )
    return null;
  return { targets: targets as NotifyTarget[], repeatHours };
}

/** What the watcher remembers of each machine between two runs. */
export interface WatchMemory {
  version: 1;
  /** When the watcher last ran: the heartbeat an off-machine check reads. */
  heartbeatAt: string;
  nodes: Record<
    string,
    { state: 'ready' | 'degraded'; since: string; notifiedAt: string | null }
  >;
}

/** One machine as fleet-status saw it: the IDs of its failing checks. */
export interface Observation {
  node: string;
  failing: string[];
}

export interface Notification {
  event: 'degraded' | 'recovered' | 'still-degraded' | 'test';
  node: string;
  checks: string[];
}

/** Required failures and early disk warnings reach the configured targets. */
export function observe(nodes: NodeReport[]): Observation[] {
  return nodes.map((node) => ({
    node: node.node,
    failing: node.checks
      .filter(
        (check) =>
          (check.status === 'fail' && check.required !== false) ||
          (check.status === 'warn' && check.id === 'worker:capacity:disk')
      )
      .map((check) => check.id),
  }));
}

/** Notifications on transitions only (ready to degraded and back), and a
 * reminder for a machine that stays degraded longer than the repeat interval.
 * A machine never seen before counts as ready.
 */
export function transitions(
  previous: WatchMemory | null,
  observed: Observation[],
  now: Date,
  repeatHours: number
): { notifications: Notification[]; memory: WatchMemory } {
  const at = now.toISOString();
  const notifications: Notification[] = [];
  const nodes: WatchMemory['nodes'] = {};
  for (const { node, failing } of observed) {
    const before = previous?.nodes[node];
    const state = failing.length ? 'degraded' : 'ready';
    const checks = failing.filter(safe);
    if (state === (before?.state ?? 'ready')) {
      const due = state === 'degraded' && repeatDue(before, now, repeatHours);
      if (due) notifications.push({ event: 'still-degraded', node, checks });
      nodes[node] = before
        ? { ...before, ...(due ? { notifiedAt: at } : {}) }
        : { state, since: at, notifiedAt: null };
      continue;
    }
    notifications.push({
      event: state === 'degraded' ? 'degraded' : 'recovered',
      node,
      checks,
    });
    nodes[node] = { state, since: at, notifiedAt: at };
  }
  return { notifications, memory: { version: 1, heartbeatAt: at, nodes } };
}

function repeatDue(
  before: WatchMemory['nodes'][string] | undefined,
  now: Date,
  repeatHours: number
): boolean {
  if (repeatHours <= 0 || !before?.notifiedAt) return false;
  return (
    now.getTime() - Date.parse(before.notifiedAt) >= repeatHours * 3_600_000
  );
}

/** The memory stored last time, or null when there is none to trust. */
export function parseMemory(text: string | null): WatchMemory | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      !record(value) ||
      value['version'] !== 1 ||
      typeof value['heartbeatAt'] !== 'string' ||
      !record(value['nodes'])
    )
      return null;
    return value as unknown as WatchMemory;
  } catch {
    return null;
  }
}

/** Node and check IDs are the only words a notification carries. */
const safe = (id: string): boolean => /^[A-Za-z0-9:._@-]{1,128}$/.test(id);

const WORDS: Record<Notification['event'], string> = {
  degraded: 'is degraded',
  recovered: 'is ready again',
  'still-degraded': 'is still degraded',
  test: 'sent a test notification',
};

export function notificationText(notification: Notification): string {
  const node = safe(notification.node) ? notification.node : 'a machine';
  const checks = notification.checks.filter(safe);
  return `dev-fleet: ${node} ${WORDS[notification.event]}${
    checks.length ? `. Failing checks: ${checks.join(', ')}` : ''
  }`;
}

/** Sends one notification to every target. The result names the target and
 * whether it took the notification: never its address or its answer.
 */
export async function deliver(
  config: NotifyConfig,
  notification: Notification,
  secrets: SecretsProvider,
  send: typeof fetch = fetch
): Promise<Check[]> {
  const text = notificationText(notification);
  const checks: Check[] = [];
  for (const target of config.targets) {
    const id = `notify:${target}`;
    const url = await secrets(NOTIFY_TARGETS[target]);
    if (!url || !/^https?:\/\//.test(url)) {
      checks.push({
        id,
        status: 'fail',
        summary: 'NOTIFY_TARGET_UNAVAILABLE',
        remedy: {
          action: `Store the address of the ${target} target as the secret "${NOTIFY_TARGETS[target]}" with the secret provider fleet.json names.`,
        },
      });
      continue;
    }
    const ok = await send(url, request(target, notification, text))
      .then((response) => response.ok)
      .catch(() => false);
    checks.push(
      ok
        ? {
            id,
            status: 'pass',
            summary: `The ${target} target took the notification.`,
          }
        : {
            id,
            status: 'fail',
            summary: 'NOTIFY_DELIVERY_FAILED',
            remedy: {
              action: `Check that the ${target} target answers, then run devfleet fleet-watch --test.`,
            },
          }
    );
  }
  return checks;
}

function request(
  target: NotifyTarget,
  notification: Notification,
  text: string
): RequestInit {
  const signal = AbortSignal.timeout(15_000);
  if (target === 'ntfy')
    return {
      method: 'POST',
      body: text,
      headers: {
        Title: `dev-fleet: ${notification.event}`,
        Tags:
          notification.event === 'recovered' ? 'white_check_mark' : 'warning',
      },
      signal,
    };
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'dev-fleet',
      event: notification.event,
      node: safe(notification.node) ? notification.node : null,
      checks: notification.checks.filter(safe),
      text,
    }),
    signal,
  };
}
