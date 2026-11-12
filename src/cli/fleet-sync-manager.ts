import { blocking, type Check, type Runner } from '../types';
import type { FleetDefinition } from '../definition';
import type { ManagerNode } from '../manager-sync';
import { hostId } from '../topology';
import { convergeProxy } from '../proxy-converge';
import { attempt } from '../node-converge-shared';
import { quotaLimited, verifyFleetProviders } from '../agents/fleet-verify';
import { verifyNativeAgents } from '../agents/native-verify';
import { convergeManagerHub } from '../monitoring/manager-hub';
import { enrollManagerMonitoring } from './fleet-sync-monitoring';
import { installConfig } from '../fleet-config';
import { IDES } from '../ide';
import { enabled, managerChecks } from '../ide/orchestrate';
import { idesOf } from '../ide/definition';
import macos from '../../ansible/macos/policy.json';
import { ansibleCommand } from '../platform/ansible';
import { PACKAGE_ROOT } from '../package-info';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The manager converges itself locally (never over SSH) before any worker:
 * it must be the declared manager, stay awake on AC power, and host every
 * singleton service (CLI proxy, Beszel hub). Workers only consume them.
 */
export async function convergeManager(
  definition: FleetDefinition,
  input: {
    revision: string;
    apply: boolean;
    workspace: string;
  },
  run: Runner
): Promise<ManagerNode> {
  const started = Date.now();
  const id = definition.manager.id;
  const identity = await managerIdentity(id, run);
  const checks: Check[] = [identity];
  if (identity.status === 'pass') {
    // Launchers and scheduled jobs on the manager read the installed copy.
    if (input.apply) installConfig();
    checks.push(await managerPower(run, input.workspace));
    checks.push(await managerDocker(run));
    // Each enabled IDE: its settings, pinned version and policy.
    checks.push(
      ...(await managerChecks(enabled(idesOf(definition), IDES), {
        id,
        workspace: input.workspace,
        apply: input.apply,
        run,
      }))
    );
    if (input.apply) {
      // Same provider profiles and the same Vault gateway credential as every
      // worker: the instances above launch from these profiles, and the check
      // proves the credential works end to end through the shared proxy.
      checks.push(
        ...(await attempt('configuration:apply', () =>
          managerAgentProfiles(id, input.workspace, run)
        ))
      );
      const providers = await attempt('provider:verification', () =>
        verifyFleetProviders(id)
      );
      checks.push(...providers);
      // Same agents, versions and shared accounts as every worker.
      checks.push(
        ...(await attempt('agent:verification', () =>
          verifyNativeAgents(id, input.workspace, run, {
            outOfQuota: quotaLimited(providers),
          })
        ))
      );
    }
    checks.push(
      ...(await convergeProxy(id, input.revision, run, {
        apply: input.apply,
        cwd: input.workspace,
      }))
    );
    if (input.apply) {
      const hub = await convergeManagerHub(input.workspace, definition, run);
      checks.push(...hub);
      // The manager is always a monitored system on its own hub.
      if (!hub.some(blocking))
        checks.push(
          ...(await enrollManagerMonitoring(definition, input.workspace, run))
        );
    }
  }
  return {
    node: id,
    role: 'manager',
    checks,
    reachability: 'online',
    desiredRevision: input.revision,
    appliedRevision:
      input.apply && !checks.some(blocking) ? input.revision : null,
    durationMs: Date.now() - started,
  };
}

const PROFILE_TOOLS = [
  'codex',
  'claude',
  'gemini',
  'opencode',
  'grok',
  'antigravity',
] as const;

/** Applies the proxy agent profiles the managed T3 instances launch from
 * (codex-proxy.ts refuses to start with a missing or stale profile). Workers
 * apply the same profiles from a pinned deployment; the manager's checkout is
 * the human's working tree, so only the workstation sources must be clean
 * (the `agents apply` owner enforces that) and nothing else is touched.
 */
export async function managerAgentProfiles(
  id: string,
  workspace: string,
  run: Runner
): Promise<Check[]> {
  for (const tool of PROFILE_TOOLS) {
    const result = await run(
      [
        'mise',
        'exec',
        '--locked',
        'bun',
        '--',
        'bun',
        'src/agents/cli.ts',
        '--json',
        '--yes',
        '--non-interactive',
        'agents',
        'apply',
        '--node',
        id,
        '--tool',
        tool,
        '--profile',
        'proxy',
      ],
      { cwd: workspace, timeoutMs: 120_000 }
    );
    if (!result.ok)
      return [
        {
          id: 'configuration:apply',
          status: 'fail',
          summary: 'MANAGER_AGENT_PROFILES_FAILED',
          remedy: {
            action: `Run bun src/agents/cli.ts --yes agents apply --node ${id} --tool ${tool} --profile proxy in the dev-fleet checkout on the manager and review the result.`,
          },
        },
      ];
  }
  return [
    {
      id: 'configuration:apply',
      status: 'pass',
      summary: `The manager has the same proxy agent profiles as every worker (${PROFILE_TOOLS.join(', ')}).`,
    },
  ];
}

/** fleet-sync runs only on the declared manager. */
export async function managerIdentity(id: string, run: Runner): Promise<Check> {
  const result = await run(['scutil', '--get', 'LocalHostName']);
  const local = result.ok ? hostId(result.stdout.trim()) : '';
  return local === id
    ? {
        id: 'manager:identity',
        status: 'pass',
        summary: `This machine is the declared fleet manager (${id}).`,
      }
    : {
        id: 'manager:identity',
        status: 'fail',
        summary: 'FLEET_NOT_MANAGER',
        remedy: {
          action: `Run fleet-sync on the manager (${id}). Workers are never controlled from another worker; change the manager only by editing manager in fleet.json and moving its singleton services.`,
        },
      };
}

/** Workers depend on the manager's services, so it never sleeps on AC power.
 * Measures every setting `ansible/macos/manager.yml` declares, from the same
 * policy file the playbook applies.
 */
export async function managerPower(
  run: Runner,
  workspace = '.'
): Promise<Check> {
  const result = await run(['pmset', '-g', 'custom']);
  const ac = result.ok ? (result.stdout.split('AC Power:')[1] ?? '') : '';
  const observed = (key: string) =>
    new RegExp(`^\\s*${key}\\s+(\\S+)`, 'm').exec(ac)?.[1];
  const drifted = Object.entries(macos.pmset)
    .filter(([key, value]) => observed(key) !== value)
    .map(([key]) => key);
  return drifted.length === 0
    ? {
        id: 'manager:power',
        status: 'pass',
        summary: 'The manager never sleeps on AC power.',
      }
    : {
        id: 'manager:power',
        status: 'fail',
        summary: drifted.includes('sleep')
          ? 'MANAGER_SLEEPS_ON_POWER'
          : `MANAGER_POWER_POLICY_DRIFT ${drifted.join(' ')}`,
        remedy: {
          action: `Workers lose the CLI proxy and Beszel hub while the manager sleeps. Apply the manager power policy once, as an administrator: cd ${workspace} && ${ansibleCommand().join(' ')} -K ansible/macos/manager.yml`,
        },
      };
}

/** The Docker Desktop release `mise.toml` pins, as the engine names itself. */
export function pinnedDockerDesktop(root = PACKAGE_ROOT): string {
  const { vars } = Bun.TOML.parse(
    readFileSync(join(root, 'mise.toml'), 'utf8')
  ) as { vars: Record<string, string> };
  return `Docker Desktop ${vars['docker_desktop_version']} (${vars['docker_desktop_build']})`;
}

/** The manager's services run in Docker Desktop, which no playbook installs
 * and which updates itself: the pinned release is measured, and a different
 * one warns instead of failing the run.
 */
export async function managerDocker(
  run: Runner,
  pinned = pinnedDockerDesktop()
): Promise<Check> {
  const result = await run(
    ['docker', 'version', '--format', '{{.Server.Platform.Name}}'],
    { timeoutMs: 20_000 }
  );
  const observed = result.ok ? result.stdout.trim() : '';
  if (observed === pinned)
    return {
      id: 'manager:docker',
      status: 'pass',
      summary: `The manager runs the pinned ${pinned}.`,
    };
  return {
    id: 'manager:docker',
    status: 'warn',
    summary: observed
      ? 'MANAGER_DOCKER_DESKTOP_DRIFT'
      : 'MANAGER_DOCKER_DESKTOP_UNOBSERVED',
    remedy: {
      action: `The manager's services are tested on ${pinned}. Install that release and turn off its automatic updates, or expect differences; fleet-sync does not install or replace Docker Desktop.`,
    },
  };
}
