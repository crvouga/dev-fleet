import { runAnsibleWithReceipt } from '../platform/ansible-receipt';
import { convergeManagerHub } from './manager-hub';
import { resolve } from 'node:path';
import { fleet } from '../fleet-config';
import { hubUrl, roleOf } from '../topology';
import { record } from '../config';
import { isRevision } from '../machine/state';
import { privateHub } from './beszel';
import { runLockedCommand as runCommand } from '../runner';
import type { Check, Runner } from '../types';

export async function applyAgent(
  value: unknown,
  root: string,
  run: Runner
): Promise<Check[]> {
  const request = validateRequest(value);
  const definition = fleet;
  await validateSource(request, root, run);
  const role = roleOf(definition, request.node);
  if (role === null) throw new Error('BESZEL_NOT_ENROLLED');
  if (request.mode === 'hub') {
    // The hub runs only on the manager; workers only ever run the agent.
    if (role !== 'manager') throw new Error('BESZEL_NOT_HUB');
    return convergeManagerHub(root, definition, run);
  }
  if (
    typeof request.publicKey !== 'string' ||
    typeof request.token !== 'string'
  )
    throw new Error('BESZEL_CREDENTIALS_REQUIRED');
  // Agents connect only to the manager's private hub URL.
  if (privateHub(request.hubUrl) !== privateHub(hubUrl(definition)))
    throw new Error('BESZEL_HUB_MISMATCH');
  return installAgent(request, root, run);
}

/** Workers (Linux) install a hardened systemd unit. The macOS manager's own
 * agent is a per-user launch agent installed locally by fleet-sync
 * (installManagerAgent), never through this remote entry point.
 */
async function installAgent(
  request: Request,
  root: string,
  run: Runner
): Promise<Check[]> {
  const monitoring = resolve(root, 'ansible/monitoring');
  const result = await runAnsibleWithReceipt(
    run,
    'agent.yml',
    {
      cwd: monitoring,
      timeoutMs: 300_000,
      input: JSON.stringify({
        beszel_node: request.node,
        beszel_hub_url: privateHub(request.hubUrl),
        beszel_public_key: request.publicKey,
        beszel_agent_token: request.token,
      }),
    },
    {
      name: 'beszel-agent',
      sources: [monitoring],
      verify: () => agentActive(run),
    }
  );
  if (!result.ok)
    return [
      {
        id: 'beszel:installation',
        status: 'fail',
        summary: 'BESZEL_INSTALLATION_INCOMPLETE',
        remedy: {
          action:
            'Inspect sudo, signed artifact access, free disk and existing service ownership. Preserve the native agent DATA_DIR and rerun the manager.',
        },
      },
    ];
  const ready = await agentActive(run);
  return [
    {
      id: 'beszel:service',
      status: ready ? 'pass' : 'fail',
      summary: ready
        ? 'Native Beszel service is enabled and active; hub metrics remain a separate gate.'
        : 'BESZEL_SERVICE_STOPPED',
    },
  ];
}
async function agentActive(run: Runner): Promise<boolean> {
  return (
    (await run(['systemctl', 'is-enabled', 'beszel-agent.service'])).ok &&
    (await run(['systemctl', 'is-active', 'beszel-agent.service'])).ok
  );
}
interface Request {
  node: string;
  revision: string;
  hubUrl: string;
  mode?: unknown;
  publicKey?: unknown;
  token?: unknown;
}
function validateRequest(value: unknown): Request {
  if (
    !record(value) ||
    typeof value['node'] !== 'string' ||
    !isRevision(value['revision']) ||
    typeof value['hubUrl'] !== 'string'
  )
    throw new Error('BESZEL_INPUT_INVALID');
  return value as unknown as Request;
}
async function validateSource(
  request: Request,
  root: string,
  run: Runner
): Promise<void> {
  for (const [args, expected] of [
    [['git', 'rev-parse', 'HEAD'], request.revision],
    [['git', 'rev-parse', '--show-toplevel'], resolve(root)],
    [['git', 'status', '--porcelain'], ''],
  ] as const) {
    const observed = await run([...args], { cwd: root });
    if (!observed.ok || observed.stdout.trim() !== expected)
      throw new Error('BESZEL_SOURCE_MISMATCH');
  }
}
async function main(): Promise<Check[]> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 16_384) throw new Error('BESZEL_INPUT_LIMIT');
  }
  return applyAgent(JSON.parse(raw), process.cwd(), runCommand);
}
/** Turns a known refusal into structured evidence; anything else is redacted. */
export function refusal(error: unknown): Check[] {
  const code = error instanceof Error ? error.message : '';
  const action = REFUSALS[code];
  return [
    action
      ? {
          id: 'beszel:operation',
          status: 'fail',
          summary: code,
          remedy: { action },
        }
      : {
          id: 'beszel:operation',
          status: 'fail',
          summary: 'BESZEL_OPERATION_INCOMPLETE',
        },
  ];
}
const REFUSALS: Record<string, string> = {
  BESZEL_NOT_HUB:
    'The Beszel hub runs only on the manager. Workers run only the agent; converge the hub from the manager with fleet-sync.',
  BESZEL_NOT_ENROLLED:
    'Declare this machine in fleet.json (the manager or a worker) before enrolling monitoring.',
  BESZEL_SOURCE_MISMATCH:
    'The checkout is not the clean, expected revision. Rerun fleet-sync so the reviewed source is installed first.',
  BESZEL_HUB_MISMATCH:
    "Agents connect only to the manager's private hub URL from fleet.json. Rerun fleet-sync from an up-to-date checkout.",
  BESZEL_CREDENTIALS_REQUIRED:
    'Agent enrollment credentials were not delivered. Rerun fleet-sync from the manager.',
};
if (import.meta.main) {
  const checks = await main().catch(refusal);
  process.stdout.write(JSON.stringify({ version: 1, checks }));
}
