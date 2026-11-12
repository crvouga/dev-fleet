import { workerReadiness } from './worker-readiness';
import { runAnsible } from './platform/ansible';
import { runAnsibleWithReceipt } from './platform/ansible-receipt';
import { loadedT3Policy, stageT3Policy } from './platform/t3-policy';
import { verifyUbuntuBoot } from './platform/ubuntu-verify';
import { verifyResourceSafety } from './platform/resource-verify';
import { convergeT3Route, T3_ROUTE } from './platform/t3-route';
import { convergeProxy } from './proxy-converge';
import { IDES } from './ide';
import { enabled, settingsChecks } from './ide/orchestrate';
import { idesOf } from './ide/definition';
import { fleet } from './fleet-config';
import { quotaLimited, verifyFleetProviders } from './agents/fleet-verify';
import { verifyNativeAgents } from './agents/native-verify';
import { accountContext, nodeAccountChecks } from './accounts/context';
import { managedT3, managedT3Desktop } from '../bootstrap/native-t3';
import {
  convergeT3Service,
  runningVersionCheck,
  t3StartedAt,
} from './platform/t3-service';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { auditUbuntu } from './platform/ubuntu-audit';
import { convergeGitIdentity } from './git-identity';
import { workerSelection } from '../bootstrap/worker-tools';
import {
  applyAgentProfiles,
  attempt,
  configureWorkstation,
} from './node-converge-shared';
import type { Check, Runner } from './types';

/** Ubuntu worker convergence: Ansible owns OS policy, services and recovery; the
 * native T3, proxy and provider owners run only after the baseline passes.
 */
export async function convergeLinux(
  root: string,
  target: { node: string; revision: string },
  run: Runner
): Promise<Check[]> {
  const { node, revision } = target;
  const audit = await auditUbuntu(run);
  if (!audit.supported || !audit.passwordlessSudo)
    return [
      {
        id: 'ubuntu:prerequisites',
        status: 'fail',
        summary: audit.supported
          ? 'SUDO_AUTHORIZATION_REQUIRED'
          : 'UBUNTU_BASELINE_MISMATCH',
        remedy: {
          action:
            'Authorize designated-user sudo through the manager enrollment flow; unsupported releases require an explicit migration.',
        },
      },
    ];
  const checks: Check[] = [];
  checks.push(
    ...(await attempt('tailscale:configuration', async () => [
      await applyTailscale(root, run),
    ]))
  );
  const { baseline, verified } = await baselineStep(root, run, node);
  checks.push(...baseline, ...verified);
  checks.push(...(await t3AfterBaseline(root, { node, baseline, run })));
  checks.push(
    ...(await attempt('workstation:configuration', () =>
      configureWorkstation(root, run)
    ))
  );
  checks.push(
    ...(await attempt('git:configuration', () =>
      convergeGitIdentity(root, fleet.git, run)
    ))
  );
  checks.push(
    ...(await attempt('configuration:apply', () =>
      applyAgentProfiles(root, node, revision, run)
    ))
  );
  checks.push(
    ...(await attempt('proxy:configuration', () =>
      convergeProxy(node, revision, run)
    ))
  );
  const providers = await attempt('provider:verification', () =>
    verifyFleetProviders(node)
  );
  checks.push(...providers);
  const accounts = await accountContext();
  checks.push(
    ...(await attempt('accounts:verification', () =>
      nodeAccountChecks(accounts)
    ))
  );
  checks.push(
    ...(await attempt('agent:verification', () =>
      verifyNativeAgents(node, root, run, {
        outOfQuota: quotaLimited(providers),
        // Where T3 starts them: the environment of its user service.
        t3Service: true,
        ...(accounts ? { accounts } : {}),
      })
    ))
  );
  checks.push(
    ...(await attempt('worker:readiness', () => workerReadiness(run, node)))
  );
  return checks;
}

/** Applies the baseline (skipped on an unchanged, verified receipt), then
 * measures boot and resource policy. Self-healing: if a skipped baseline's
 * effective policy no longer verifies, the baseline is applied in full and
 * measured again in the same run.
 */
async function baselineStep(
  root: string,
  run: Runner,
  node: string
): Promise<{ baseline: Check[]; verified: Check[] }> {
  const measure = async () => [
    ...(await attempt('ubuntu:boot-policy', () =>
      verifyUbuntuBoot(userInfo().username, run)
    )),
    ...(await attempt('ubuntu:resource-safety', () =>
      verifyResourceSafety(userInfo().homedir, run)
    )),
  ];
  let cached = false;
  let baseline = await attempt('ubuntu:baseline', async () => {
    const applied = await applyBaseline(root, run, false, node);
    cached = applied.cached;
    return applied.checks;
  });
  let verified = await measure();
  if (cached && verified.some((check) => check.status === 'fail')) {
    baseline = await attempt('ubuntu:baseline', async () => {
      return (await applyBaseline(root, run, true, node)).checks;
    });
    verified = await measure();
  }
  return { baseline, verified };
}

async function applyBaseline(
  root: string,
  run: Runner,
  force: boolean,
  node: string
): Promise<{ cached: boolean; checks: Check[] }> {
  const user = userInfo();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 'baseline.yml'),
    {
      cwd: ubuntu,
      timeoutMs: 900_000,
      input: JSON.stringify({
        development_source: root,
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        // The web profile brings headless Chromium (tasks/browser.yml).
        worker_tool_profiles: workerSelection(fleet, node).profiles,
      }),
    },
    {
      name: 'ubuntu-baseline',
      sources: [ubuntu],
      force,
      verify: () => baselineServicesActive(run),
    }
  );
  return {
    cached: result.cached,
    checks: [
      {
        id: 'ubuntu:baseline',
        status: result.ok ? 'pass' : 'fail',
        summary: result.ok
          ? result.cached
            ? 'Ubuntu baseline unchanged since its last successful apply and its services are active (re-applied in full at least daily).'
            : 'Ubuntu baseline tasks completed, including always-on service recovery; effective boot/session policies require separate verification.'
          : 'UBUNTU_BASELINE_INCOMPLETE',
      },
    ],
  };
}

/** Cheap probe for what the baseline owns: system services and user timers. */
async function baselineServicesActive(run: Runner): Promise<boolean> {
  const system = await run([
    'systemctl',
    'is-active',
    '--quiet',
    'ssh.service',
    'tailscaled.service',
    'docker.service',
  ]);
  if (!system.ok) return false;
  const user = await run([
    'systemctl',
    '--user',
    'is-active',
    '--quiet',
    'personal-worker-auth.timer',
  ]);
  return user.ok;
}

async function applyTailscale(root: string, run: Runner): Promise<Check> {
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const tailscale = await runAnsibleWithReceipt(
    run,
    'tailscale.yml',
    { cwd: ubuntu, timeoutMs: 300_000, input: '{}' },
    {
      name: 'ubuntu-tailscale',
      sources: [ubuntu],
      verify: async () => {
        const status = await run(['tailscale', 'status', '--json']);
        return (
          status.ok &&
          (JSON.parse(status.stdout) as { BackendState?: unknown })
            .BackendState === 'Running'
        );
      },
    }
  );
  return {
    id: 'tailscale:configuration',
    status: tailscale.ok ? 'pass' : 'fail',
    summary: tailscale.ok
      ? 'Pinned native Tailscale service is enabled, running and authenticated; manager reachability remains separate.'
      : 'TAILSCALE_SETUP_OR_LOGIN_REQUIRED',
  };
}

async function convergeT3(
  root: string,
  node: string,
  run: Runner
): Promise<Check[]> {
  const artifact = managedT3();
  const startedAt = await t3StartedAt(run);
  const checks = await convergeT3Service(
    artifact,
    run,
    async () => {
      const staged = await stageT3Policy(root, artifact.path, run, node);
      return staged.status === 'pass' ? [] : [staged];
    },
    () => installT3Desktop(root, run)
  );
  if (checks.every((check) => check.status === 'pass'))
    checks.push(
      await loadedT3Policy(artifact.path, run, {
        restarted: startedAt !== (await t3StartedAt(run)),
      })
    );
  // Settings are watched by T3: providers, names and the profile apply
  // without a restart.
  checks.push(
    ...(await settingsChecks(enabled(idesOf(fleet), IDES), {
      id: node,
      workspace: root,
      apply: true,
      run,
    }))
  );
  const serviceReady = checks.some(
    (check) => check.id === 't3:service' && check.status === 'pass'
  );
  if (serviceReady) checks.push(await runningVersionCheck(run, userInfo().uid));
  if (serviceReady)
    checks.push(
      ...(await convergeT3Route(run, () => publishT3Route(root, run)))
    );
  if (serviceReady) checks.push(...(await enableWorkerRecovery(root, run)));
  return checks;
}

async function publishT3Route(root: string, run: Runner): Promise<boolean> {
  const result = await runAnsible(run, 't3-route.yml', {
    cwd: resolve(root, 'ansible/ubuntu'),
    input: JSON.stringify({ t3_route_target: T3_ROUTE.proxy }),
    timeoutMs: 60_000,
  });
  return result.ok;
}

async function installT3Desktop(root: string, run: Runner): Promise<boolean> {
  const user = userInfo();
  const desktop = managedT3Desktop();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 't3-desktop.yml'),
    {
      cwd: root,
      timeoutMs: 600_000,
      input: JSON.stringify({
        development_source: root,
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
        t3_desktop_url: desktop.url,
        t3_desktop_name: desktop.name,
        t3_desktop_sha256: desktop.sha256,
      }),
    },
    {
      name: 'ubuntu-t3-desktop',
      sources: [ubuntu],
      // A stopped or disabled app reruns the play, which starts it.
      verify: async () =>
        (
          await run([
            'systemctl',
            '--user',
            'is-enabled',
            '--quiet',
            't3code-desktop.service',
          ])
        ).ok &&
        (
          await run([
            'systemctl',
            '--user',
            'is-active',
            '--quiet',
            't3code-desktop.service',
          ])
        ).ok,
    }
  );
  return result.ok;
}

async function t3AfterBaseline(
  root: string,
  context: { node: string; baseline: Check[]; run: Runner }
): Promise<Check[]> {
  const { node, baseline, run } = context;
  if (baseline.some((check) => check.status !== 'pass'))
    return [
      {
        id: 't3:prerequisites',
        status: 'skip',
        summary: 'T3_BASELINE_PREREQUISITES_REQUIRED',
        remedy: {
          action:
            'Complete the designated-user baseline and lingering policy before changing native service lifecycle. Existing service state is preserved.',
        },
      },
    ];
  return attempt('t3:service', () => convergeT3(root, node, run));
}

async function enableWorkerRecovery(
  root: string,
  run: Runner
): Promise<Check[]> {
  const user = userInfo();
  const ubuntu = resolve(root, 'ansible/ubuntu');
  const result = await runAnsibleWithReceipt(
    run,
    resolve(ubuntu, 'recovery.yml'),
    {
      cwd: root,
      timeoutMs: 60_000,
      input: JSON.stringify({
        development_source: root,
        development_user: user.username,
        development_uid: user.uid,
        development_home: user.homedir,
      }),
    },
    {
      name: 'ubuntu-recovery',
      sources: [ubuntu],
      verify: async () =>
        (
          await run([
            'systemctl',
            '--user',
            'is-active',
            '--quiet',
            'personal-worker-recovery.timer',
          ])
        ).ok,
    }
  );
  return [
    {
      id: 'worker:service-recovery',
      status: result.ok ? 'pass' : 'fail',
      summary: result.ok
        ? 'T3 recovery enabled: a stopped desktop app is started and an unresponsive one restarted after three failed one-minute health checks.'
        : 'WORKER_RECOVERY_SETUP_FAILED',
    },
  ];
}
