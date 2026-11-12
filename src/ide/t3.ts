import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Check, FleetNode } from '../types';
import type { Ide, MachineContext, WorkerContext } from './ide';
import { fleet } from '../fleet-config';
import { machineProviders } from '../t3/providers';
import { providerNames } from '../t3/names-check';
import { profileCheck } from '../t3/profile';
import { modelsCheck } from '../t3/models';
import { proxyAccounts, type Roster } from '../t3/accounts';
import {
  MACOS_POLICY,
  managerVersion,
  updatesCheck,
  workerVersion,
} from '../t3/version';
import { verifyT3Endpoint } from '../t3-endpoint';
import { observedIdentity, verifyT3Linked } from '../t3-linked-check';
import { T3_RESTARTED_SUMMARY } from '../platform/t3-policy';
import { ansibleCommand } from '../platform/ansible';

/** Where T3 keeps its data on this machine. */
const t3Home = (): string =>
  resolve(process.env['T3CODE_HOME'] ?? join(homedir(), '.t3'));

/** What the T3 checks read besides the machine: injected by scenarios. */
export interface T3Inputs {
  t3Home?: string;
  roster?: Roster;
  profile?: Record<string, unknown>;
  requiredModels?: Record<string, string[]>;
  policyPath?: string;
}

/** T3 Code, the first supported IDE. Its install, service and policy on
 * workers are the `ansible/ubuntu/t3*` playbooks and on the manager
 * `ansible/macos/t3-policy.yml`; everything else is reached from here.
 */
export function t3Ide(inputs: T3Inputs = {}): Ide {
  const home = () => inputs.t3Home ?? t3Home();
  const settings = async (context: MachineContext): Promise<Check[]> => {
    const required = inputs.requiredModels ?? fleet.t3?.requiredModels;
    const options = {
      t3Home: home(),
      ...(inputs.roster ? { roster: inputs.roster } : {}),
    };
    return [
      await machineProviders(
        context.id,
        context.workspace,
        context.apply,
        options
      ),
      await providerNames(
        context.id,
        context.workspace,
        context.apply,
        options
      ),
      await profileCheck(
        join(home(), 'userdata/settings.json'),
        inputs.profile ?? fleet.t3?.profile ?? {},
        { apply: context.apply }
      ),
      await modelsCheck({
        t3Home: home(),
        roster: inputs.roster ?? proxyAccounts,
        ...(required ? { required } : {}),
      }),
    ];
  };
  return {
    id: 't3',
    settings,
    async manager(context) {
      return [
        ...(await settings(context)),
        await managerVersion(home(), context.workspace),
        await updatesCheck(
          inputs.policyPath ?? MACOS_POLICY,
          `cd ${context.workspace} && ${ansibleCommand().join(' ')} -e user=$(id -un) -K ansible/macos/manager-privilege.yml`
        ),
      ];
    },
    async worker(node: FleetNode, context: WorkerContext) {
      const checks = [...(await verifyT3Endpoint(node, context.run))];
      // A worker T3 restarted by this sync (idle policy heal) needs a minute
      // or two before the manager's link reconnects.
      const restarted = context.earlier.some(
        (check) => check.summary === T3_RESTARTED_SUMMARY
      );
      const linked = await verifyT3Linked(node, context.run, {
        reconnectMs: restarted ? 180_000 : 0,
      });
      checks.push(linked);
      if (
        linked.status !== 'fail' &&
        !node.t3EnvironmentId &&
        context.remember
      ) {
        const identity = await observedIdentity(node, context.run).catch(
          () => undefined
        );
        if (identity)
          await context.remember(node.id, identity).catch(() => undefined);
      }
      checks.push(await workerVersion(node, context.run, context.workspace));
      return checks;
    },
  };
}
