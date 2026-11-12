import { blocking, type Check, type Runner } from '../types';
import type { FleetDefinition } from '../definition';
import type { ManagerNode } from '../manager-sync';
import { convergeProxy } from '../proxy-converge';
import { attempt } from '../node-converge-shared';
import { quotaLimited, verifyFleetProviders } from '../agents/fleet-verify';
import { verifyNativeAgents } from '../agents/native-verify';
import { accountContext, nodeAccountChecks } from '../accounts/context';
import { convergeManagerHub } from '../monitoring/manager-hub';
import { enrollManagerMonitoring } from './fleet-sync-monitoring';
import { installConfig } from '../fleet-config';
import { IDES } from '../ide';
import { enabled, managerChecks } from '../ide/orchestrate';
import { idesOf } from '../ide/definition';
import { convergeGitIdentity, gitChecks } from '../git-identity';
import { ansibleCommand, runAnsible } from '../platform/ansible';
import { convergeGithub } from '../github/converge';
import { PACKAGE_ROOT } from '../package-info';
import { managerHealth } from '../manager-health';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  MACOS_MANAGER,
  managerHost,
  type ManagerHost,
} from '../platform/manager-host';
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
  const host = managerHost(definition.manager.os);
  const identity = await managerIdentity(id, run, host);
  const checks: Check[] = [identity];
  if (identity.status === 'pass') {
    // Launchers and scheduled jobs on the manager read the installed copy.
    if (input.apply) installConfig();
    checks.push(
      input.apply
        ? await holdManagerPower(run, input.workspace, host)
        : await managerPower(run, input.workspace, host)
    );
    checks.push(await managerBootRecovery(run, input.workspace, host));
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
    checks.push(...(await managerHealth(run)));
    if (input.apply) {
      // Same provider profiles and the same Vault gateway credential as every
      // worker: the instances above launch from these profiles, and the check
      // proves the credential works end to end through the shared proxy.
      checks.push(
        ...(await attempt('configuration:apply', () =>
          managerAgentProfiles(id, input.workspace, run)
        ))
      );
      // The same Git identity and GitHub credentials as every worker.
      checks.push(
        ...(await attempt('git:configuration', () =>
          convergeGitIdentity(input.workspace, definition.git, run)
        ))
      );
      if (definition.git)
        checks.push(...(await gitChecks(definition.git, run)));
      // The same GitHub sign-in as every worker, or only a check of a
      // person's own login when the configuration names one. git asks gh
      // for the token through the helper git.yml declared above.
      checks.push(
        ...(await attempt('github:sync', async () => [
          await convergeGithub(input.workspace, run),
        ]))
      );
      const providers = await attempt('provider:verification', () =>
        verifyFleetProviders(id)
      );
      checks.push(...providers);
      // Same agents, versions and shared accounts as every worker.
      const accounts = await accountContext();
      checks.push(
        ...(await attempt('accounts:verification', () =>
          nodeAccountChecks(accounts)
        ))
      );
      checks.push(
        ...(await attempt('agent:verification', () =>
          verifyNativeAgents(id, input.workspace, run, {
            outOfQuota: quotaLimited(providers),
            ...(accounts ? { accounts } : {}),
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
export async function managerIdentity(
  id: string,
  run: Runner,
  host: ManagerHost = MACOS_MANAGER,
  platform: NodeJS.Platform = process.platform
): Promise<Check> {
  const local = (await host.localHostName(run)) ?? '';
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
          action:
            platform === 'darwin'
              ? `Run fleet-sync on the manager (${id}). Workers are never controlled from another worker; change the manager only by editing manager in fleet.json and moving its singleton services.`
              : `This machine runs ${platform}, and the manager is always a macOS machine. Run fleet-sync on the manager (${id}), or from a worker that can SSH to it.`,
        },
      };
}

/** Workers depend on the manager's services, so it never sleeps on AC power.
 * Measures every setting `ansible/macos/manager.yml` declares, from the same
 * policy file the playbook applies. A setting pmset does not list on AC power
 * is one this Mac does not have (a virtual Mac has no womp): the playbook
 * skips it, so it is not applicable here either.
 */
export async function managerPower(
  run: Runner,
  workspace = '.',
  host: ManagerHost = MACOS_MANAGER
): Promise<Check> {
  const { drifted, notApplicable } = await host.powerDrift(run);
  return drifted.length === 0
    ? {
        id: 'manager:power',
        status: 'pass',
        summary:
          notApplicable.length === 0
            ? 'The manager never sleeps on AC power.'
            : `The manager never sleeps on AC power; not applicable on this Mac: ${notApplicable.join(' ')}.`,
      }
    : {
        id: 'manager:power',
        status: 'fail',
        summary: drifted.includes('sleep')
          ? 'MANAGER_SLEEPS_ON_POWER'
          : `MANAGER_POWER_POLICY_DRIFT ${drifted.join(' ')}`,
        remedy: {
          action: `Workers lose the CLI proxy and Beszel hub while the manager sleeps. Grant the manager its power settings once, as an administrator; every fleet-sync then applies the policy with no prompt: cd ${workspace} && ${ansibleCommand().join(' ')} -e user=$(id -un) -K ansible/macos/manager-privilege.yml`,
        },
      };
}

/** After a power cut the manager comes back by itself: the machine starts
 * again, a user session exists for its per-user services, and the container
 * engine that hosts the proxy and the hub starts with it. A FileVault Mac
 * waits for a person; that is reported as a warning with its consequence.
 */
export async function managerBootRecovery(
  run: Runner,
  workspace = '.',
  host: ManagerHost = MACOS_MANAGER,
  home = homedir()
): Promise<Check> {
  const items = await host.bootRecovery(run, home);
  const failing = items.filter((entry) => entry.status === 'fail');
  const warning = items.filter((entry) => entry.status === 'warn');
  if (!failing.length && !warning.length)
    return {
      id: 'manager:boot-recovery',
      status: 'pass',
      summary: 'The manager comes back by itself after a power cut or reboot.',
    };
  const named = failing.length ? failing : warning;
  return {
    id: 'manager:boot-recovery',
    status: failing.length ? 'fail' : 'warn',
    summary: `MANAGER_BOOT_RECOVERY_INCOMPLETE ${named.map((entry) => entry.item).join(' ')}`,
    remedy: {
      action: [
        ...[...failing, ...warning].map((entry) => entry.detail),
        host.bootRemedy(workspace),
      ].join(' '),
    },
  };
}

/** Whether the one grant manager-privilege.yml installs is in place: this
 * user may run `pmset -c` without a password. Lists, never runs.
 */
async function powerGranted(run: Runner): Promise<boolean> {
  return (
    await run(['sudo', '-n', '-l', '/usr/bin/pmset', '-c', 'sleep', '0'], {
      timeoutMs: 10_000,
    })
  ).ok;
}

/** On every applying sync: a drifted power policy is applied with
 * manager.yml when the grant is in place, then measured again. Without the
 * grant the check says how to give it, once.
 */
export async function holdManagerPower(
  run: Runner,
  workspace = '.',
  host: ManagerHost = MACOS_MANAGER,
  { root = PACKAGE_ROOT, scratch }: { root?: string; scratch?: string } = {}
): Promise<Check> {
  const before = await managerPower(run, workspace, host);
  if (
    before.status === 'pass' ||
    host.platform !== 'macOS' ||
    !(await powerGranted(run))
  )
    return before;
  await runAnsible(
    run,
    join(root, 'ansible/macos/manager.yml'),
    { input: '{}', timeoutMs: 120_000 },
    scratch
  );
  return managerPower(run, workspace, host);
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
