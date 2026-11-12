import type { Check, FleetNode, Runner } from '../types';

/** What every supported IDE is asked for. An implementation owns its own
 * install, service and policy (an Ansible role per IDE, with the common
 * variable contract: version, checksum, policy, instances, profile) and is
 * reached only through these calls, so the orchestration never names one.
 */
export interface Ide {
  /** The name the fleet configuration enables it by, under `ides`. */
  readonly id: string;
  /** The IDE's settings on this machine: provider instances from the account
   * roster, the declared profile and the models it offers. Run on the manager
   * and on every worker by the machine itself.
   */
  settings(context: MachineContext): Promise<Check[]>;
  /** The manager's own IDE: its settings, its pinned version and its policy. */
  manager(context: MachineContext): Promise<Check[]>;
  /** What the manager measures of a worker's IDE: remote access, pairing and
   * the version the worker runs.
   */
  worker(node: FleetNode, context: WorkerContext): Promise<Check[]>;
}

export interface MachineContext {
  /** The node ID this machine is in the fleet. */
  id: string;
  /** The checkout this run applies. */
  workspace: string;
  apply: boolean;
  run: Runner;
}

export interface WorkerContext {
  run: Runner;
  /** The manager's checkout of the revision this sync applies. */
  workspace: string;
  /** The checks this sync already reported for the worker. */
  earlier: Check[];
  /** Records what identifies the worker's IDE in the fleet state, the first
   * time it is seen through a verified link.
   */
  remember?: (node: string, identity: string) => Promise<void>;
}
