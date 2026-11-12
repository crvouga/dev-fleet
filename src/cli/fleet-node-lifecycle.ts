import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config';
import {
  HOST_KEY,
  type FleetDefinition,
  type MachineDefinition,
} from '../definition';
import { hubAccess } from '../monitoring/hub-access';
import type { HubRequest } from '../monitoring/enroll';
import { moveSystem, removeSystem } from '../monitoring/systems';
import {
  declaredConnection,
  hostKeyAlias,
  renderKnownHosts,
} from '../ssh-connection';
import { changeWorkers, readPins } from '../state/workers';
import { hubUrl } from '../topology';
import { FleetUsageError } from '../errors';
import { fleet, secret } from '../fleet-config';
import {
  deviceLeftToPerson,
  tailnetCleanup,
  type TailnetCleanup,
} from '../tailnet-cleanup';
import type { Enrollment } from '../machine/state';
import { PACKAGE_ROOT } from '../package-info';
import { runAnsible } from '../platform/ansible';
import { makeReport, renderReport } from '../report';
import { runCommand } from '../runner';
import { loadEnrollment, storeEnrollment } from '../state/enrollment';
import { STATE_ROSTER, writeRosterText } from '../state/roster';
import { mutateState, stateContext, type StateContext } from '../state/sync';
import { discoverTailnet, type TailnetComputer } from '../tailscale';
import type { Check, FleetConfig, FleetNode, Runner } from '../types';
import { usesVault } from '../vault-config';
import { managerT3, type ManagerT3 } from '../t3/peer-link';
import { pairAndRecord } from '../t3/pairing';
import {
  issueWorkerToken,
  revokeWorkerToken,
  workerTokenLocation,
} from '../worker-credentials';
import type { CommandOutcome } from './contracts';
import { readRoster } from './roster';

export interface NodeLifecycleOptions {
  id?: string;
  /** The replacement's SSH host key, `TYPE BASE64`, verified out of band or
   * written by the seed that created it.
   */
  hostKey?: string;
  apply?: boolean;
  yes?: boolean;
}

export interface NodeLifecycleServices {
  run: Runner;
  /** The roster: the fleet state's, or a file `--config` names. */
  roster: string;
  definition: () => FleetDefinition;
  vault: () => boolean;
  /** The manager's known_hosts file. */
  knownHosts: string;
  state: () => StateContext;
  /** Applies a playbook of the package with these variables. */
  playbook: (name: string, variables: object) => Promise<boolean>;
  now: () => Date;
  /** The monitoring hub's API, signed in as the fleet account. Absent, the
   * hub is left as it is and the step says so.
   */
  monitoring?: () => Promise<HubRequest>;
  /** Removes a worker's old device from the tailnet, so a new machine gets
   * the declared name: the control plane fleet.json declares, asked with the
   * `tailnet-admin` secret. Absent, no device is removed and the step is
   * reported as skipped, with what a person does instead.
   */
  tailnet?: TailnetCleanup;
  /** The manager's own T3, which pairs with a replacement's environment. */
  t3: () => ManagerT3;
}

export type { TailnetCleanup };

export function lifecycleServices(roster: string): NodeLifecycleServices {
  return {
    run: runCommand,
    roster,
    definition: () => fleet,
    vault: usesVault,
    knownHosts: join(homedir(), '.ssh/known_hosts'),
    state: () => stateContext(runCommand),
    playbook: async (name, variables) =>
      (
        await runAnsible(runCommand, join(PACKAGE_ROOT, 'ansible', name), {
          input: JSON.stringify(variables),
          timeoutMs: 300_000,
        })
      ).ok,
    now: () => new Date(),
    monitoring: async () => (await hubAccess(hubUrl(fleet))).request,
    // Only a fleet that declares a tailnet control plane removes devices.
    ...(fleet.tailnet
      ? { tailnet: tailnetCleanup(fleet.tailnet, secret) }
      : {}),
    t3: () => managerT3(runCommand),
  };
}

function declared(
  definition: FleetDefinition,
  id: string | undefined
): MachineDefinition {
  const worker = definition.workers.find((entry) => entry.id === id);
  if (!worker)
    throw new FleetUsageError(
      '--id must name a worker fleet.json declares. To retire a worker, retire it first and then remove it from fleet.json.'
    );
  return worker;
}

/** The name ssh checks the host key of: the HostName the alias resolves to,
 * as `[host]:port` when the port is not 22.
 */
export async function keyName(
  worker: MachineDefinition,
  run: Runner
): Promise<string> {
  // A worker reached from declared data is pinned under its fleet ID.
  if (!worker.ssh) return hostKeyAlias(worker.id);
  const resolved = await run(['ssh', '-G', worker.ssh], { timeoutMs: 10_000 });
  const option = (name: string) =>
    resolved.ok
      ? new RegExp(`^${name} (\\S+)$`, 'm').exec(resolved.stdout)?.[1]
      : undefined;
  const host =
    option('hostname') ?? worker.network?.tailscaleName ?? worker.ssh;
  const port = option('port') ?? String(worker.network?.sshPort ?? 22);
  return port === '22' ? host : `[${host}]:${port}`;
}

/** Changes the roster in the fleet state (or the file `--config` names). */
async function changeRoster(
  services: NodeLifecycleServices,
  change: (roster: FleetConfig | null) => FleetConfig | null
): Promise<void> {
  const save = async () => {
    const next = change(await readRoster(services.roster));
    if (next)
      await writeRosterText(
        services.roster,
        `${JSON.stringify(parseConfig(next), null, 2)}\n`
      );
  };
  if (services.roster === STATE_ROSTER)
    await mutateState(services.state(), save);
  else await save();
}

function outcome(
  command: string,
  id: string,
  checks: Check[],
  applied: boolean
): CommandOutcome {
  const report = { ...makeReport(command, [{ node: id, checks }]), applied };
  return {
    exitCode: checks.some((check) => check.status === 'fail') ? 1 : 0,
    data: report,
    text: renderReport(report),
  };
}

const planned = (id: string, summary: string): Check => ({
  id,
  status: 'skip',
  summary: `Planned: ${summary}`,
});

const preview = (options: NodeLifecycleOptions): boolean =>
  !(options.apply && options.yes);

/** Takes a worker out of the fleet for good: revokes its Vault token,
 * forgets its pinned host key, deletes its monitoring system, removes the
 * manager's T3 link to it and its tailnet device (when the tailnet control is
 * wired), removes its roster entry and leaves a tombstone in the fleet state.
 * Preview until --apply --yes. Running it again changes nothing.
 */
export async function fleetNodeRetire(
  options: NodeLifecycleOptions,
  services: NodeLifecycleServices
): Promise<CommandOutcome> {
  const worker = declared(services.definition(), options.id);
  const roster = await readRoster(services.roster);
  const entry = roster?.nodes.find((node) => node.id === worker.id);
  if (entry && roster!.nodes.length === 1)
    throw new FleetUsageError(
      'The roster must keep at least one worker. Add the replacement with fleet-node-add first.'
    );
  return retireWorker(worker, entry, services, !preview(options));
}

/** Retires one worker; with `apply` false it only plans. Shared with the
 * retirement of a worker whose record disappeared (fleet-sync).
 */
export async function retireWorker(
  worker: MachineDefinition,
  entry: FleetNode | undefined,
  services: NodeLifecycleServices,
  apply: boolean
): Promise<CommandOutcome> {
  const host = await keyName(worker, services.run);
  if (!apply)
    return outcome(
      'fleet-node-retire',
      worker.id,
      planRetirement(worker, entry, host, services.vault()),
      false
    );
  const checks: Check[] = [];
  if (services.vault())
    checks.push(await revokeWorkerToken(worker.id, services.run));
  checks.push(await pinHostKey(worker, host, null, services));
  checks.push(
    await onHub(services, (request) => removeSystem(request, worker.id))
  );
  if (entry?.t3EnvironmentId)
    checks.push(await unlinkT3(entry.t3EnvironmentId, services.run));
  if (entry?.tailscaleId)
    checks.push(await removeDevice(worker, entry.tailscaleId, services));
  await changeRoster(services, (current) =>
    current && current.nodes.some((node) => node.id === worker.id)
      ? {
          ...current,
          nodes: current.nodes.filter((node) => node.id !== worker.id),
        }
      : null
  );
  checks.push({
    id: 'enrollment:connection',
    status: 'pass',
    summary: `${worker.id} is not in the roster.`,
  });
  // Nothing of the worker stays in the fleet state but its tombstone.
  await changeWorkers(services.state(), () => ({ [worker.id]: null }));
  checks.push(await tombstone(worker.id, services));
  return outcome('fleet-node-retire', worker.id, checks, true);
}

function planRetirement(
  worker: MachineDefinition,
  entry: FleetNode | undefined,
  host: string,
  vault: boolean
): Check[] {
  return [
    ...(vault
      ? [planned('auth:worker-token', `revoke ${worker.id}'s Vault token`)]
      : []),
    planned('ssh:host-key', `forget the host key of ${host}`),
    planned('beszel:system', `delete the monitoring system ${worker.id}`),
    ...(entry?.t3EnvironmentId
      ? [
          planned(
            't3:link',
            `remove the manager's T3 link to ${entry.t3EnvironmentId}`
          ),
        ]
      : []),
    ...(entry?.tailscaleId
      ? [
          planned(
            'tailscale:device',
            `remove the tailnet device ${entry.tailscaleId}`
          ),
        ]
      : []),
    planned(
      'enrollment:connection',
      entry
        ? `remove ${worker.id} from the roster`
        : `${worker.id} is not in the roster`
    ),
    planned('state:retired', `record that ${worker.id} is retired`),
  ];
}

/** Pins `key` as a worker's host key, or forgets it (null). A worker reached
 * from declared data is pinned in the fleet state, and the fleet-owned
 * known_hosts is rendered again; one reached through the operator's own SSH
 * alias is pinned in their known_hosts by the pinned Ansible.
 */
export async function pinHostKey(
  worker: MachineDefinition,
  host: string,
  key: string | null,
  services: Pick<
    NodeLifecycleServices,
    'state' | 'playbook' | 'knownHosts' | 'now' | 'definition'
  >
): Promise<Check> {
  if (!declaredConnection(worker)) {
    const pinned = await services.playbook('macos/worker-host-key.yml', {
      host,
      ...(key ? { pin: 'present', key } : { pin: 'absent' }),
      known_hosts: services.knownHosts,
    });
    if (!pinned) return hostKeyFailure();
    return {
      id: 'ssh:host-key',
      status: 'pass',
      summary: key
        ? `The manager trusts exactly the given host key of ${host}.`
        : `The manager no longer trusts any host key of ${host}.`,
    };
  }
  const at = services.now().toISOString();
  await changeWorkers(services.state(), (current) => {
    const {
      hostKey: _key,
      hostKeyPinnedAt: _at,
      ...rest
    } = current[worker.id] ?? {};
    return {
      [worker.id]: key ? { ...rest, hostKey: key, hostKeyPinnedAt: at } : rest,
    };
  });
  renderKnownHosts(services.definition(), process.env, readPins());
  return {
    id: 'ssh:host-key',
    status: 'pass',
    summary: key
      ? `The fleet state pins exactly the given host key of ${worker.id}.`
      : `The fleet state pins no host key of ${worker.id}.`,
  };
}

/** One change on the monitoring hub. A hub that cannot be reached is a
 * warning, never a reason to stop.
 */
async function onHub(
  services: NodeLifecycleServices,
  change: (request: HubRequest) => Promise<Check>
): Promise<Check> {
  if (!services.monitoring)
    return {
      id: 'beszel:system',
      status: 'skip',
      summary: 'The monitoring hub was not asked: there is no hub access here.',
    };
  try {
    return await change(await services.monitoring());
  } catch (error) {
    return {
      id: 'beszel:system',
      status: 'warn',
      summary:
        error instanceof Error && /^BESZEL_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'BESZEL_API_UNAVAILABLE',
      remedy: {
        action:
          'The hub was not changed. Run fleet-sync on the manager so the hub answers, then run this command again; fleet-status --workers lists systems that match no declared worker.',
      },
    };
  }
}

/** Forgets the manager's T3 link to an environment that is gone. */
async function unlinkT3(environment: string, run: Runner): Promise<Check> {
  const result = await run(['t3', 'environment', 'unlink', environment], {
    timeoutMs: 30_000,
  });
  return result.ok
    ? {
        id: 't3:link',
        status: 'pass',
        summary: `The manager no longer links to the T3 environment ${environment}.`,
      }
    : {
        id: 't3:link',
        status: 'warn',
        summary: 'T3_LINK_UNLINK_FAILED',
        remedy: {
          action: `Remove the link to ${environment} in the manager's T3 (Settings, Connections), then run the command again.`,
        },
      };
}

async function removeDevice(
  worker: MachineDefinition,
  device: string,
  services: NodeLifecycleServices
): Promise<Check> {
  if (services.tailnet) return services.tailnet.removeDevice(worker, device);
  return deviceLeftToPerson(worker, device);
}

async function tombstone(
  id: string,
  services: NodeLifecycleServices
): Promise<Check> {
  const record = async (): Promise<Enrollment | null> => {
    const enrollment = await loadEnrollment(null);
    if (!enrollment) return null;
    const { [id]: _applied, ...workers } = enrollment.workers ?? {};
    const retired = {
      ...enrollment,
      workers,
      retired: {
        ...enrollment.retired,
        [id]: enrollment.retired?.[id] ?? services.now().toISOString(),
      },
    };
    storeEnrollment(retired);
    return retired;
  };
  const stored = (await mutateState(services.state(), record)).value;
  return stored
    ? {
        id: 'state:retired',
        status: 'pass',
        summary: `The fleet state records that ${id} was retired at ${stored.retired![id]}.`,
      }
    : {
        id: 'state:retired',
        status: 'skip',
        summary:
          'No revision was ever applied to this fleet, so there is nothing to record.',
      };
}

/** Puts a fresh machine in place of a worker under the same id: verifies the
 * new device on the tailnet, pins its host key, binds the roster entry to the
 * new device, points its monitoring system at it, removes the manager's T3
 * link to the old environment, pairs the manager's T3 with the new one (now,
 * or in the next fleet-sync once it runs), removes the old tailnet device
 * (when the tailnet control is wired) and issues it a token of its own
 * (revoking the old one).
 * Preview until --apply --yes; then `fleet-sync --node ID` brings it to
 * ready. When nothing changed (the same device, the same key, a token of its
 * own) it changes nothing.
 */
export async function fleetNodeReplace(
  options: NodeLifecycleOptions,
  services: NodeLifecycleServices
): Promise<CommandOutcome> {
  const worker = declared(services.definition(), options.id);
  const entry = await replaceable(worker, options, services);
  const device = await newDevice(worker, services.run);
  if ('check' in device)
    return outcome('fleet-node-replace', worker.id, [device.check], false);
  const replaced = entry.tailscaleId !== device.computer.id;
  const plan: Replacement = {
    worker,
    node: { ...entry, tailscaleId: device.computer.id },
    device: device.computer.id,
    host: await keyName(worker, services.run),
    hostKey: options.hostKey,
    replaced,
    needsToken: false,
    ...(replaced && entry.tailscaleId ? { previous: entry.tailscaleId } : {}),
    ...(replaced && entry.t3EnvironmentId
      ? { environment: entry.t3EnvironmentId }
      : {}),
  };
  plan.needsToken =
    services.vault() &&
    (plan.replaced || !(await ownToken(worker.id, services.run)));
  const identity: Check = {
    id: 'tailscale:identity',
    status: 'pass',
    summary: `${worker.id} is the online device ${plan.device}${plan.replaced ? `, replacing ${entry.tailscaleId ?? 'none'}` : ''}.`,
  };
  if (preview(options))
    return outcome(
      'fleet-node-replace',
      worker.id,
      [identity, ...planReplacement(plan)],
      false
    );
  return outcome(
    'fleet-node-replace',
    worker.id,
    [identity, ...(await carryOut(plan, services))],
    true
  );
}

interface Replacement {
  worker: MachineDefinition;
  /** The roster entry, bound to the new device. */
  node: FleetNode;
  device: string;
  host: string;
  hostKey: string | undefined;
  replaced: boolean;
  needsToken: boolean;
  /** The device the worker ran as before, when it changed. */
  previous?: string;
  /** The T3 environment the manager linked to before, when it changed. */
  environment?: string;
}

async function replaceable(
  worker: MachineDefinition,
  options: NodeLifecycleOptions,
  services: NodeLifecycleServices
) {
  if (options.hostKey !== undefined && !HOST_KEY.test(options.hostKey))
    throw new FleetUsageError(
      '--host-key expects one public key, "TYPE BASE64", as ssh-keyscan or the seed prints it.'
    );
  if (options.hostKey !== undefined && worker.network?.hostKey)
    throw new FleetUsageError(
      `${worker.id}'s host key is declared by its worker record. Change hostKey in the record instead; it is pinned on the next command.`
    );
  const roster = await readRoster(services.roster);
  const entry = roster?.nodes.find((node) => node.id === worker.id);
  if (!entry)
    throw new FleetUsageError(
      `${worker.id} is not in the roster. Add it with fleet-node-add first.`
    );
  return entry;
}

function planReplacement(plan: Replacement): Check[] {
  const steps: Check[] = [];
  if (plan.hostKey)
    steps.push(planned('ssh:host-key', `pin the host key of ${plan.host}`));
  if (plan.replaced)
    steps.push(
      planned(
        'enrollment:connection',
        `bind ${plan.worker.id} to ${plan.device}`
      ),
      planned(
        'beszel:system',
        `point the monitoring system ${plan.worker.id} at the new machine`
      )
    );
  if (plan.environment)
    steps.push(
      planned('t3:link', `remove the manager's T3 link to ${plan.environment}`)
    );
  if (plan.replaced)
    steps.push(
      planned(
        't3:link',
        `pair the manager's T3 with the new T3 environment of ${plan.worker.id}`
      )
    );
  if (plan.previous)
    steps.push(
      planned('tailscale:device', `remove the tailnet device ${plan.previous}`)
    );
  if (plan.needsToken)
    steps.push(
      planned('auth:worker-token', `issue ${plan.worker.id} a token of its own`)
    );
  return steps;
}

async function carryOut(
  plan: Replacement,
  services: NodeLifecycleServices
): Promise<Check[]> {
  const { worker } = plan;
  const steps: Check[] = [];
  if (plan.hostKey)
    steps.push(await pinHostKey(worker, plan.host, plan.hostKey, services));
  if (plan.replaced) {
    await changeRoster(services, (current) =>
      current
        ? {
            ...current,
            nodes: current.nodes.map((node) => {
              if (node.id !== worker.id) return node;
              // The old environment's identity goes with the old machine:
              // the next sync records the new one once it is linked.
              const { t3EnvironmentId: _old, ...rest } = node;
              return { ...rest, tailscaleId: plan.device };
            }),
          }
        : null
    );
    steps.push({
      id: 'enrollment:connection',
      status: 'pass',
      summary: `The roster binds ${worker.id} to the device ${plan.device}.`,
    });
    steps.push(
      await onHub(services, (request) =>
        moveSystem(
          request,
          worker.id,
          worker.network?.tailscaleName ?? plan.host
        )
      )
    );
  }
  if (plan.environment)
    steps.push(await unlinkT3(plan.environment, services.run));
  if (plan.replaced) steps.push(await pairReplacement(plan.node, services));
  if (plan.previous)
    steps.push(await removeDevice(worker, plan.previous, services));
  if (plan.needsToken) {
    const revoked = await revokeWorkerToken(worker.id, services.run);
    steps.push(
      revoked.status === 'fail'
        ? revoked
        : await issueWorkerToken(worker.id, services.run)
    );
  }
  steps.push({
    id: 'rollout:next',
    status: 'pass',
    summary: `Run devfleet fleet-sync --node ${worker.id} to converge the new machine.`,
  });
  return steps;
}

/** Pairs the manager's T3 with a replacement's environment and records it
 * in the roster. A machine whose T3 does not run yet (or refuses) is left to
 * the next fleet-sync, which pairs it once it runs.
 */
function pairReplacement(
  node: FleetNode,
  services: NodeLifecycleServices
): Promise<Check> {
  return pairAndRecord(node, {
    roster: services.roster,
    run: services.run,
    manager: services.t3(),
    context: services.state,
    now: services.now,
  });
}

async function ownToken(id: string, run: Runner): Promise<boolean> {
  const location = workerTokenLocation(id);
  return (
    await run(
      [
        'vault',
        'kv',
        'get',
        `-mount=${location.mount}`,
        '-field=accessor',
        location.path,
      ],
      { timeoutMs: 20_000 }
    )
  ).ok;
}

/** The one online computer on the tailnet that carries the worker's name. */
async function newDevice(
  worker: MachineDefinition,
  run: Runner
): Promise<{ computer: TailnetComputer } | { check: Check }> {
  const tailnet = await discoverTailnet(run);
  const name = (
    worker.network?.tailscaleName ??
    worker.ssh ??
    ''
  ).toLowerCase();
  const short = name.split('.')[0]!;
  const found = tailnet.computers.filter(
    (computer) =>
      !computer.self &&
      computer.online &&
      [computer.dns.toLowerCase(), computer.name.toLowerCase()].some(
        (candidate) => candidate === name || candidate.split('.')[0] === short
      )
  );
  if (found.length === 1) return { computer: found[0]! };
  return {
    check: {
      id: 'tailscale:identity',
      status: 'fail',
      summary: found.length
        ? 'TAILSCALE_IDENTITY_CONFLICT'
        : 'TAILSCALE_NODE_MISSING',
      remedy: {
        action: found.length
          ? `More than one online device is named like ${worker.id}. Remove the old device from the tailnet, then run the command again.`
          : `No online device is named like ${worker.id}. Start the new machine, join it to the tailnet under that name, then run the command again.`,
      },
    },
  };
}

function hostKeyFailure(): Check {
  return {
    id: 'ssh:host-key',
    status: 'fail',
    summary: 'SSH_HOST_KEY_NOT_CHANGED',
    remedy: {
      action:
        'The pinned Ansible could not change known_hosts on this manager. Run devfleet fleet-validate --ansible, then this command again.',
    },
  };
}
