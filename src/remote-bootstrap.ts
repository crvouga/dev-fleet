import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareSource } from './machine/source';
import { isRevision } from './machine/state';
import { sshArgs, shellQuote, sshFailure } from './ssh';
import type {
  FleetNode,
  NodeReport,
  Runner,
  Check,
  CommandResult,
} from './types';
import {
  followOperation,
  realClock,
  retrying,
  RETRY_PAUSES_MS,
  transient,
  type Clock,
  type Follow,
} from './remote-operation';
import { record } from './config';
import { installedDefinition, type FleetDefinition } from './definition';
import { cleanCheck, validCheck } from './protocol';
import { UBUNTU_RELEASES } from './platform/ubuntu-release';
import { T3_RESTART_MODES } from './platform/t3-service';

export interface BootstrapPayload {
  revision: string;
  script: string;
  bundle: string;
  digest: string;
  authorizeSudo?: string;
  /** The fleet configuration every node keeps at ~/.config/dev-fleet/fleet.json. */
  config?: string;
  /** `fleet-sync --restart-busy`: a worker's T3 restarts for a new release or
   * policy even while agent turns run. By default it waits for idle.
   */
  restartBusy?: boolean;
}

/** No manager tool installation; Git/source preparation is part of apply approval. */
export async function prepareBootstrap(
  root: string,
  revision: string,
  run: Runner,
  options: { definition?: FleetDefinition; checkout?: string } = {}
): Promise<BootstrapPayload | null> {
  if (!isRevision(revision)) return null;
  const source = await prepareSource(root, revision, run, options.checkout);
  if (!source) return null;
  const script = await trackedScript(
    source,
    revision,
    'bootstrap/fleet-remote-bootstrap.sh',
    run
  );
  const sudoScript = await trackedScript(
    source,
    revision,
    'ansible/ubuntu/authorize-sudo.sh',
    run
  );
  if (!script || !sudoScript) return null;
  const payload = await bundleRevision(
    { root, source, revision },
    { script, authorizeSudo: sudoScript },
    run
  );
  // The fleet configuration is data, not source: it travels beside the code.
  return payload && options.definition
    ? { ...payload, config: installedDefinition(options.definition) }
    : payload;
}

/** Workers run one revision and never need history: the bundle holds only the
 * approved commit and its files (about a quarter of the full history), and the
 * receiving checkout is marked shallow at that commit. `git bundle create`
 * cannot cut history, so the v2 bundle is written directly: a header naming
 * the commit, then a pack of exactly its objects.
 */
const SNAPSHOT_BUNDLE = [
  'objects=$(git rev-list --objects --no-walk "$1") || exit 1',
  '{ printf \'# v2 git bundle\\n%s refs/personal-fleet/%s\\n\\n\' "$1" "$1"',
  'printf \'%s\\n\' "$objects" | git pack-objects --stdout -q; } >"$2"',
].join('\n');

async function bundleRevision(
  {
    root,
    source,
    revision,
  }: { root: string; source: string; revision: string },
  scripts: { script: string; authorizeSudo: string },
  run: Runner
): Promise<BootstrapPayload | null> {
  const path = join(root, `transfer-${randomUUID()}.bundle`);
  try {
    const bundled = await run(
      ['sh', '-c', SNAPSHOT_BUNDLE, 'bundle', revision, path],
      { cwd: source, timeoutMs: 120_000 }
    );
    if (!bundled.ok || (await stat(path)).size > 512 * 1024 * 1024) return null;
    const bundle = await readFile(path);
    return {
      revision,
      ...scripts,
      bundle: bundle.toString('base64'),
      digest: createHash('sha256').update(bundle).digest('hex'),
    };
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
export async function bootstrapRemote(
  node: FleetNode,
  payload: BootstrapPayload,
  run: Runner,
  follow: Follow = {}
): Promise<NodeReport> {
  const clock = follow.clock ?? realClock;
  const cached = await cachedRevision(node, payload.revision, run, clock);
  if (typeof cached !== 'boolean') return { node: node.id, checks: [cached] };
  const transfer = cached
    ? { mode: 'cached', bundle: '' }
    : { mode: 'transfer', bundle: payload.bundle };
  const command = [
    'sh',
    '-c',
    payload.script,
    'fleet-bootstrap',
    payload.revision,
    payload.digest,
    node.id,
    transfer.mode,
    UBUNTU_RELEASES.map((entry) => entry.release).join(' '),
    T3_RESTART_MODES[payload.restartBusy ? 1 : 0],
  ]
    .map(shellQuote)
    .join(' ');
  const checks = await bootstrapSessions(
    node,
    payload,
    { command, input: bootstrapInput(payload.config, transfer.bundle) },
    { run, follow: { ...follow, clock } }
  );
  return { node: node.id, checks };
}

/** Opens the bootstrap session, and again after a lost one unless the
 * worker's own operation can be followed to its end instead.
 */
async function bootstrapSessions(
  node: FleetNode,
  payload: BootstrapPayload,
  session: { command: string; input: string },
  context: { run: Runner; follow: Follow & { clock: Clock } }
): Promise<Check[]> {
  const { run, follow } = context;
  let result: CommandResult | undefined;
  for (const pause of [0, ...RETRY_PAUSES_MS]) {
    if (result) {
      // The session was lost, not the operation: the worker keeps running
      // it, so the manager follows it rather than starting another.
      await follow.clock.pause(pause);
      const followed = await followOperation(
        node,
        payload.revision,
        run,
        follow
      );
      if (followed) return followed;
    }
    result = await run([...sshArgs(node), session.command], {
      input: session.input,
      timeoutMs: 5_400_000,
    });
    const evidence = parseEvidence(result);
    if (evidence && locked(evidence))
      return (
        (await followOperation(node, payload.revision, run, follow)) ?? evidence
      );
    if (evidence) return evidence;
    if (result.reason !== 'exit' || !transient(result)) break;
  }
  if (!result!.ok) return [sshFailure(result!)];
  return [
    {
      id: 'bootstrap:protocol',
      status: 'fail',
      summary: 'REMOTE_BOOTSTRAP_EVIDENCE_INVALID',
      remedy: {
        action:
          'Inspect the source-owned remote operation and lock. Do not assume a manager disconnect stopped installation.',
      },
    },
  ];
}

/** Another operation holds the worker: its lock was the first thing tried. */
function locked(checks: Check[]): boolean {
  return checks.some((check) => check.summary === 'FLEET_REMOTE_LOCKED');
}

/** What the bootstrap reads on stdin: one line with the fleet configuration
 * (installed under the remote lock, so overlapping runs never both write it),
 * then the bundle when the worker lacks the revision.
 */
export function bootstrapInput(
  config: string | undefined,
  bundle: string
): string {
  const line = config ? Buffer.from(config).toString('base64') : '';
  return `${line}\n${bundle}`;
}

async function cachedRevision(
  node: FleetNode,
  revision: string,
  run: Runner,
  clock: Clock
): Promise<boolean | Check> {
  const command = `d="$HOME/.local/share/personal/fleet/revisions/${revision}"; test ! -L "$d" && test -d "$d/.git" && test "$(git -C "$d" rev-parse HEAD 2>/dev/null)" = '${revision}' && test "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" = "$d" && clean=$(git -C "$d" status --porcelain 2>/dev/null) && test -z "$clean" && printf ready`;
  const result = await retrying(
    () => run([...sshArgs(node), command], { timeoutMs: 20_000 }),
    clock
  );
  if (!result.ok) {
    const failure = sshFailure(result);
    if (result.reason !== 'exit' || failure.id !== 'ssh:probe') return failure;
  }
  return result.ok && result.stdout === 'ready';
}

function parseEvidence(result: {
  stdout: string;
  ok: boolean;
}): Check[] | null {
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (
      record(value) &&
      value['version'] === 1 &&
      Array.isArray(value['checks']) &&
      value['checks'].length > 0 &&
      value['checks'].length <= 200 &&
      value['checks'].every(validCheck)
    ) {
      const checks = value['checks'].map(cleanCheck);
      if (!result.ok && !checks.some((check) => check.status === 'fail'))
        checks.push({
          id: 'bootstrap:exit',
          status: 'fail',
          summary: 'REMOTE_BOOTSTRAP_EXIT_FAILED',
          remedy: {
            action:
              'The remote process failed despite partial evidence. Inspect its operation state before retry; no success receipt may advance.',
          },
        });
      return checks;
    }
  } catch {
    /* Raw SSH output is never included in reports. */
  }
  return null;
}

export async function trackedScript(
  source: string,
  revision: string,
  path: string,
  run: Runner
): Promise<string | null> {
  const result = await run(['git', 'show', revision + ':' + path], {
    cwd: source,
  });
  return result.ok && result.stdout.startsWith('#!/bin/sh\n')
    ? result.stdout
    : null;
}
