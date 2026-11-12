import policy from '../../ansible/ubuntu/policy.json';
import type { Runner, Check } from '../types';

/** The user unit that runs the pinned desktop app (UI and embedded server). */
export const T3_DESKTOP_UNIT = 't3code-desktop.service';

/** Workers run one T3 process: the desktop app, started with the auto-login
 * graphical session. `t3-desktop.yml` installs it, retires the former headless
 * server and starts the app; this only refuses a foreign launcher beforehand
 * and measures the result afterwards.
 */
export async function convergeT3Service(
  artifact: { path: string; version: string },
  run: Runner,
  prepare: () => Promise<Check[]> = async () => [],
  install: () => Promise<boolean> = async () => true
): Promise<Check[]> {
  const existing = await run(['t3', '--version']);
  if (conflictingVersion(existing, artifact.version))
    return pending(
      'T3_EXECUTABLE_OWNER_CONFLICT',
      'The existing T3 launcher has a different version. Review the pinned release; preserve its application data and active sessions.'
    );
  const preparation = await prepare();
  if (preparation.length) return preparation;
  if (!(await install()))
    return pending(
      'T3_DESKTOP_INSTALL_FAILED',
      'Inspect the t3-desktop.yml Ansible output (package download, apt, GDM auto-login, user unit). T3 data in ~/.t3 is untouched.'
    );
  const active = await userctl(run, 'is-active', T3_DESKTOP_UNIT);
  const enabled = await userctl(run, 'is-enabled', T3_DESKTOP_UNIT);
  if (!active.ok || !enabled.ok)
    return pending(
      'T3_DESKTOP_STOPPED',
      `The desktop app needs the auto-login graphical session. Reboot or log in on the machine, then inspect journalctl --user -u ${T3_DESKTOP_UNIT}; ~/.t3 is preserved.`
    );
  return [
    {
      id: 't3:service',
      status: 'pass',
      summary:
        'Pinned T3 desktop app is enabled for the auto-login session and running. Private routing, policy and pairing remain separate checks.',
    },
  ];
}

/** The recovery script, installed outside every revision (`tasks/recovery.yml`). */
export const T3_HEALTH_SCRIPT = '/usr/local/lib/personal-fleet/t3-health.sh';

/** The record of the package the desktop app was unpacked from
 * (`t3-desktop.yml`): `T3-Code-<version>-<arch>.deb`. */
export const T3_DESKTOP_RELEASE =
  '/opt/T3 Code (Nightly)/.personal-fleet-version';

/** Where a play records a T3 restart it deferred because agent turns were
 * running (`tasks/t3-restart.yml`): the second it was first deferred.
 * personal-worker-recovery clears it when it restarts the idle app. */
export function t3RestartMarker(uid: number): string {
  return `/run/user/${uid}/personal-t3-restart-pending`;
}

/** A restart deferred while agent turns run, and whether it has waited longer
 * than the policy allows. */
export async function restartDeferral(
  run: Runner,
  uid: number,
  now: number = Date.now()
): Promise<{ pending: boolean; overdue: boolean }> {
  const marker = await run(['cat', t3RestartMarker(uid)]);
  if (!marker.ok) return { pending: false, overdue: false };
  const since = Number(marker.stdout.trim());
  const limit = policy.t3RestartMaxDeferralHours * 3600;
  return {
    pending: true,
    overdue: Number.isFinite(since) && now / 1000 - since > limit,
  };
}

/** The release the running server reports, compared with the one installed.
 * Asks the server itself, so it needs no `t3` on the search path. A new
 * release is installed beside a running app, which restarts into it only
 * while it runs no agent turn: until then this is T3_RESTART_PENDING, and a
 * failure once the restart has waited longer than the policy allows. */
export async function runningVersionCheck(
  run: Runner,
  uid: number,
  now: number = Date.now()
): Promise<Check> {
  const server = await run(
    [
      'curl',
      '--fail',
      '--silent',
      '--max-time',
      '10',
      'http://127.0.0.1:3773/.well-known/t3/environment',
    ],
    { timeoutMs: 15_000 }
  );
  const installed = await run(['cat', T3_DESKTOP_RELEASE]);
  const running = serverVersion(server.ok ? server.stdout : '');
  const release = /^T3-Code-(.+)-[a-z0-9]+\.deb$/.exec(
    installed.ok ? installed.stdout.trim() : ''
  )?.[1];
  const id = 't3:running-version';
  if (!running || !release)
    return {
      id,
      status: 'fail',
      summary: 'T3_RUNNING_VERSION_UNKNOWN',
      remedy: {
        action:
          'The running server or the installed release could not be read. Check worker:t3-health, then rerun fleet-sync to reinstall the pinned desktop app.',
      },
    };
  if (running === release)
    return {
      id,
      status: 'pass',
      summary: `The running T3 server is the installed release ${release}.`,
    };
  const deferral = await restartDeferral(run, uid, now);
  return {
    id,
    status: deferral.overdue ? 'fail' : 'warn',
    summary: 'T3_RESTART_PENDING',
    remedy: {
      action: deferral.overdue
        ? `T3 still runs ${running} after ${policy.t3RestartMaxDeferralHours} hours because agent turns kept running. Finish or stop them, or restart ${T3_DESKTOP_UNIT} on the worker (this ends its running turns).`
        : `T3 runs ${running}; ${release} is installed. personal-worker-recovery restarts it at the first check with no agent turn running.`,
    },
  };
}

function serverVersion(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    const version =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)['serverVersion']
        : undefined;
    return typeof version === 'string' && /^[\w.+-]+$/.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

/** When the desktop app last started; changes exactly when it restarts. */
export async function t3StartedAt(run: Runner): Promise<string> {
  const shown = await run([
    'systemctl',
    '--user',
    'show',
    '--property=ActiveEnterTimestampMonotonic',
    '--value',
    T3_DESKTOP_UNIT,
  ]);
  return shown.ok ? shown.stdout.trim() : '';
}

function userctl(run: Runner, verb: string, unit: string) {
  return run(['systemctl', '--user', verb, unit]);
}

function pending(code: string, action: string): Check[] {
  return [
    { id: 't3:service', status: 'fail', summary: code, remedy: { action } },
  ];
}

function conflictingVersion(
  result: { ok: boolean; stdout: string },
  version: string
): boolean {
  return result.ok && result.stdout.trim() !== `t3 v${version}`;
}
