import type { FleetDefinition } from '../definition';
import {
  controlRemedy,
  TailnetControlError,
  type TailnetControl,
} from '../tailnet-control';
import type { TailnetComputer } from '../tailscale';
import type { PackagePlaybook } from '../platform/ansible';
import type { Check, FleetNode, NodeReport } from '../types';
import { createWorkerAccount } from '../worker-account';
import {
  rebootNeeded,
  rebootWorker,
  updatesPending,
  type RebootReason,
} from '../worker-reboot';

/** What one worker's deployment needs around its converge: the converge
 * itself (bootstrap, verification, monitoring), the tailnet control plane
 * when the fleet declares one, the tailnet as the manager sees it, and what
 * the run was asked to do.
 */
export interface WorkerDeployment {
  definition: FleetDefinition;
  /** Applies a playbook of the package from the manager. */
  playbook: PackagePlaybook;
  /** One converge of the worker; `tailnetKey` is handed to its bootstrap. */
  converge: (
    node: FleetNode,
    revision: string,
    tailnetKey?: string
  ) => Promise<NodeReport>;
  /** Null when the fleet declares no tailnet control plane. */
  control: () => Promise<TailnetControl | null>;
  /** The devices of the tailnet, as the manager's Tailscale lists them. */
  computers: () => Promise<TailnetComputer[]>;
  /** The workers that converged in an earlier run. */
  readyBefore: string[];
  maintenanceReboot?: boolean;
  force?: boolean;
  /** Whether the bootstrap of this revision reads a tailnet key. */
  acceptsTailnetKey: boolean;
}

/** Deploys one worker and, around its converge: hands a worker that is not
 * on the tailnet a single-use key, keeps an enrolled worker's node key from
 * expiring, creates the declared account on an image that lets only root
 * in, and reboots the worker once when its first converge needs it (or for
 * maintenance, when asked), converging it again to verify it.
 */
export async function deployWorker(
  node: FleetNode,
  revision: string,
  deployment: WorkerDeployment
): Promise<NodeReport> {
  const before: Check[] = [];
  const key = await enrolmentKey(node, deployment, before);
  before.push(...(await keyExpiry(node, deployment)));
  let target = node;
  let result = await deployment.converge(target, revision, key);
  const account = await rootOnly(node, result, deployment);
  if (account) {
    before.push(account.check);
    if (account.node) {
      target = account.node;
      result = await deployment.converge(target, revision, key);
    }
  }
  const reason = rebootReason(node.id, result.checks, deployment);
  if (reason) {
    const reboot = await rebootWorker(
      target,
      {
        revision,
        reason,
        ...(reason === 'maintenance' && deployment.force
          ? { force: true }
          : {}),
      },
      deployment.playbook
    );
    if (reboot.status === 'pass')
      result = await deployment.converge(target, revision);
    result.checks.unshift(reboot);
  }
  result.checks.unshift(...before);
  return result;
}

/** Why this worker is rebooted now, if it is. A worker that converged
 * before is never rebooted for its first converge; only an explicit
 * maintenance run reboots it.
 */
function rebootReason(
  id: string,
  checks: Check[],
  deployment: WorkerDeployment
): RebootReason | null {
  if (deployment.maintenanceReboot && updatesPending(checks))
    return 'maintenance';
  if (!deployment.readyBefore.includes(id) && rebootNeeded(checks))
    return 'first-converge';
  return null;
}

/** A single-use, pre-authorised, tagged key for a worker the roster has no
 * tailnet identity for yet. The key is never reported.
 */
async function enrolmentKey(
  node: FleetNode,
  deployment: WorkerDeployment,
  checks: Check[]
): Promise<string | undefined> {
  if (node.tailscaleId || !deployment.acceptsTailnetKey) return undefined;
  try {
    const control = await deployment.control();
    if (!control) return undefined;
    const minted = await control.createAuthKey({ worker: node.id });
    checks.push({
      id: 'tailscale:enrolment-key',
      status: 'pass',
      summary: `A single-use, pre-authorised key tagged ${deployment.definition.tailnet!.tag}, expiring within minutes, was handed to the worker on the bootstrap's stdin.`,
    });
    return minted.key;
  } catch (error) {
    if (!(error instanceof TailnetControlError)) throw error;
    checks.push(controlFailure('tailscale:enrolment-key', error));
    return undefined;
  }
}

/** An enrolled worker's node key never expires: the control plane disables
 * expiry for a worker whose key has one (tagged workers have none on the
 * hosted Tailscale). The tailscale:key-expiry check still measures it.
 */
async function keyExpiry(
  node: FleetNode,
  deployment: WorkerDeployment
): Promise<Check[]> {
  if (!node.tailscaleId) return [];
  try {
    const control = await deployment.control();
    if (!control) return [];
    const peer = (await deployment.computers()).find(
      (computer) => computer.id === node.tailscaleId
    );
    if (peer?.keyExpiry === undefined) return [];
    await control.disableKeyExpiry(node.tailscaleId);
    return [
      {
        id: 'tailscale:key-expiry-policy',
        status: 'pass',
        summary:
          'Key expiry of this worker was disabled through the tailnet control plane; tailscale:key-expiry measures it again on the next run.',
      },
    ];
  } catch (error) {
    if (!(error instanceof TailnetControlError)) throw error;
    return [
      {
        ...controlFailure('tailscale:key-expiry-policy', error),
        status: 'warn',
      },
    ];
  }
}

function controlFailure(id: string, error: TailnetControlError): Check {
  return {
    id,
    status: 'fail',
    summary: error.code,
    remedy: { action: controlRemedy(error.code) },
  };
}

/** The bootstrap refused to run as root: the alias logs in as root. With a
 * declared account, it is created over that login and the run continues as
 * it (`user@alias`); the next runs need the alias to name it, since the SSH
 * policy turns root login off.
 */
async function rootOnly(
  node: FleetNode,
  result: NodeReport,
  deployment: WorkerDeployment
): Promise<{ check: Check; node?: FleetNode } | null> {
  if (
    !result.checks.some(
      (check) => check.summary === 'ROOT_DEVELOPMENT_USER_REJECTED'
    )
  )
    return null;
  const user = deployment.definition.workers.find(
    (worker) => worker.id === node.id
  )?.network?.user;
  const check = await createWorkerAccount(
    { ssh: node.ssh, login: '' },
    user,
    deployment.playbook
  );
  if (check.status !== 'pass') return { check };
  return {
    check: {
      ...check,
      status: 'warn',
      summary: `${check.summary} This run continued as ${user}@${node.ssh}; set User ${user} for the SSH alias ${node.ssh}, since root login is turned off.`,
    },
    node: {
      ...node,
      ssh: `${user}@${node.ssh}`,
      workspace: `/home/${user}/.local/share/personal/fleet`,
    },
  };
}
