import { runAnsible } from './ansible';
import { desired } from '../t3/desired';
import policy from '../../ansible/ubuntu/t3/policy.json';
import ubuntu from '../../ansible/ubuntu/policy.json';
import { restartDeferral } from './t3-service';
import { basename, dirname, join, resolve } from 'node:path';
import { rename, rm, symlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { Runner, Check } from '../types';

/** The administrator policy a worker's T3 runs: the fleet's
 * (`ansible/ubuntu/t3/policy.json`, which keeps linked environments on so
 * the manager pairs with a replaced worker without a person) with the
 * worker's provider instances locked.
 */
export function workerPolicy(instances: Record<string, unknown>) {
  return {
    ...policy,
    settings: {
      ...policy.settings,
      ...Object.fromEntries(
        Object.entries(instances).map(([id, value]) => [
          `providerInstances.${id}`,
          { value, locked: true },
        ])
      ),
    },
  };
}

export async function stageT3Policy(
  root: string,
  executable: string,
  run: Runner,
  target: { node: string; restartBusy?: boolean }
): Promise<Check> {
  const { node } = target;
  const instances = await desired(
    resolve(root, 'agents/t3.json'),
    await stableWorkspace(root),
    node
  );
  const user = userInfo();
  const document = workerPolicy(instances);
  const result = await runAnsible(run, 't3-policy.yml', {
    cwd: resolve(root, 'ansible/ubuntu'),
    input: JSON.stringify({
      t3_executable: executable,
      t3_policy_document: document,
      development_user: user.username,
      development_uid: user.uid,
      development_home: user.homedir,
      t3_restart_busy: target.restartBusy === true,
    }),
    timeoutMs: 120_000,
  });
  return {
    id: 't3:policy-staged',
    status: result.ok ? 'pass' : 'fail',
    summary: result.ok
      ? 'Native T3 policy validated and staged; a running T3 that had not loaded it was restarted.'
      : 'T3_POLICY_STAGE_FAILED',
    remedy: {
      action:
        'Review any existing administrator policy and the pinned native validation result. No live settings database or user state is overwritten.',
    },
  };
}
export async function verifyT3Policy(
  executable: string,
  run: Runner,
  pause: () => Promise<void> = () =>
    new Promise((done) => setTimeout(done, 1000))
): Promise<Check> {
  // A newly started native server can be active before loading its policy:
  // bounded, read-only observation.
  let loaded = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await run([executable, 'policy', 'show'], {
      timeoutMs: 5000,
    });
    loaded = result.ok && /loaded this policy\.\s*$/.test(result.stdout);
    if (loaded) break;
    if (attempt < 5) await pause();
  }
  return {
    id: 't3:policy-loaded',
    status: loaded ? 'pass' : 'fail',
    summary: loaded
      ? 'Running T3 server confirms it loaded the installed managed policy.'
      : 'T3_POLICY_RESTART_PENDING',
    remedy: {
      action:
        'T3 did not load the installed policy after a restart. Inspect systemctl --user status t3code-desktop.service on the node, then rerun fleet-sync.',
    },
  };
}

/** Summary when the policy play restarted T3: its manager link reconnects next. */
export const T3_RESTARTED_SUMMARY =
  'T3 was restarted to load the new managed policy; the running server confirms it.';

/** `t3-policy.yml` restarts a running T3 that has not loaded the staged policy
 * so every node offers the same providers, but only while it runs no agent
 * turn: a busy T3 keeps its turns and the play records the restart as
 * pending, for personal-worker-recovery to apply at the first idle check.
 * This measures the outcome; `restarted` says whether the app restarted
 * during this sync and so needs time to reconnect.
 */
export async function loadedT3Policy(
  executable: string,
  run: Runner,
  options: {
    restarted: boolean;
    pause?: () => Promise<void>;
    uid?: number;
    now?: number;
  }
): Promise<Check> {
  // A restarted desktop app takes a few seconds to come back with its server.
  const check = await verifyT3Policy(
    executable,
    run,
    options.pause ??
      (() =>
        new Promise((done) =>
          setTimeout(done, options.restarted ? 5000 : 1000)
        ))
  );
  if (check.status !== 'pass') {
    const deferral = await restartDeferral(
      run,
      options.uid ?? userInfo().uid,
      options.now
    );
    if (!deferral.pending)
      return { ...check, summary: 'T3_POLICY_RESTART_FAILED' };
    return {
      ...check,
      status: deferral.overdue ? 'fail' : 'warn',
      summary: 'T3_POLICY_RESTART_PENDING',
      remedy: {
        action: deferral.overdue
          ? `Agent turns kept T3 from loading the staged policy for ${ubuntu.t3RestartMaxDeferralHours} hours. Finish or stop them, or restart t3code-desktop.service on the worker (this ends its running turns).`
          : 'Agent turns are running, so T3 keeps them and loads the staged policy at the first check of personal-worker-recovery with no turn running.',
      },
    };
  }
  return options.restarted
    ? { ...check, summary: T3_RESTARTED_SUMMARY }
    : check;
}

/** Fleet revisions live at .../fleet/revisions/<sha> (workers) or
 * .../fleet/manager-runs/<sha> (the manager). Point .../fleet/current at the
 * applied revision and reference it from T3, so provider settings (and the T3
 * restart a policy needs) change only when they really change, not on every
 * new commit, and never name a checkout that is later pruned. Other checkouts
 * are used as-is.
 */
export async function stableWorkspace(root: string): Promise<string> {
  const current = stablePath(root);
  if (current === root) return root;
  const revisions = dirname(resolve(root));
  const staged = `${current}.${process.pid}`;
  await rm(staged, { force: true });
  await symlink(join(basename(revisions), basename(resolve(root))), staged);
  await rename(staged, current);
  return current;
}

/** Where `stableWorkspace` points for this checkout, without moving it. */
export function stablePath(root: string): string {
  const revisions = dirname(resolve(root));
  return ['revisions', 'manager-runs'].includes(basename(revisions))
    ? join(dirname(revisions), 'current')
    : root;
}
