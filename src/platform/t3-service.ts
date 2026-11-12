import policy from '../../ansible/ubuntu/policy.json';
import type { Runner, Check } from '../types';
import type { Session } from '../../bootstrap/worker-features';

/** The user unit that runs the pinned desktop app (UI and embedded server). */
export const T3_DESKTOP_UNIT = 't3code-desktop.service';
/** The lingering user unit that runs the pinned native server on a headless
 * worker (`t3-headless.yml`). */
export const T3_HEADLESS_UNIT = 't3code-headless.service';

/** The unit that runs T3 for a session type. */
export function t3Unit(session: Session = 'desktop'): string {
  return session === 'headless' ? T3_HEADLESS_UNIT : T3_DESKTOP_UNIT;
}

/** Workers run one T3 process: on a desktop worker the desktop app, started
 * with the auto-login graphical session (`t3-desktop.yml`); on a headless
 * worker the pinned native server as a lingering user service
 * (`t3-headless.yml`). The play installs it, retires the other session
 * type's unit and starts it; this only refuses a foreign launcher beforehand
 * and measures the result afterwards.
 */
export async function convergeT3Service(
  artifact: { path: string; version: string },
  run: Runner,
  steps: {
    /** Stages the policy; any check it returns stops here. */
    prepare?: () => Promise<Check[]>;
    /** Applies the session type's playbook. */
    install?: () => Promise<boolean>;
    session?: Session;
  } = {}
): Promise<Check[]> {
  const {
    prepare = async () => [],
    install = async () => true,
    session = 'desktop',
  } = steps;
  const existing = await run(['t3', '--version']);
  if (conflictingVersion(existing, artifact.version))
    return pending(
      'T3_EXECUTABLE_OWNER_CONFLICT',
      'The existing T3 launcher has a different version. Review the pinned release; preserve its application data and active sessions.'
    );
  const preparation = await prepare();
  if (preparation.length) return preparation;
  const words = SESSION_WORDS[session];
  if (!(await install())) return pending(...words.installFailed);
  const unit = t3Unit(session);
  const active = await userctl(run, 'is-active', unit);
  const enabled = await userctl(run, 'is-enabled', unit);
  if (!active.ok || !enabled.ok) return pending(...words.stopped(unit));
  return [{ id: 't3:service', status: 'pass', summary: words.running }];
}

/** What the check says of each session type: its codes and remedies. */
const SESSION_WORDS: Record<
  Session,
  {
    installFailed: [string, string];
    stopped: (unit: string) => [string, string];
    running: string;
  }
> = {
  desktop: {
    installFailed: [
      'T3_DESKTOP_INSTALL_FAILED',
      'Inspect the t3-desktop.yml Ansible output (package download, apt, GDM auto-login, user unit). T3 data in ~/.t3 is untouched.',
    ],
    stopped: (unit) => [
      'T3_DESKTOP_STOPPED',
      `The desktop app needs the auto-login graphical session. Reboot or log in on the machine, then inspect journalctl --user -u ${unit}; ~/.t3 is preserved.`,
    ],
    running:
      'Pinned T3 desktop app is enabled for the auto-login session and running. Private routing, policy and pairing remain separate checks.',
  },
  headless: {
    installFailed: [
      'T3_SERVER_INSTALL_FAILED',
      'Inspect the t3-headless.yml Ansible output (the pinned server in the toolchain, the user unit). T3 data in ~/.t3 is untouched.',
    ],
    stopped: (unit) => [
      'T3_SERVER_STOPPED',
      `The T3 server is a lingering user service and needs no login. Inspect journalctl --user -u ${unit} and loginctl show-user for Linger=yes; ~/.t3 is preserved.`,
    ],
    running:
      'Pinned T3 server is enabled as a lingering user service and running, with no display. Private routing, policy and pairing remain separate checks.',
  },
};

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
  now: number = Date.now(),
  session: Session = 'desktop'
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
  const running = serverVersion(server.ok ? server.stdout : '');
  const release = await installedRelease(run, session);
  const id = 't3:running-version';
  if (!running || !release)
    return {
      id,
      status: 'fail',
      summary: 'T3_RUNNING_VERSION_UNKNOWN',
      remedy: {
        action:
          'The running server or the installed release could not be read. Check worker:t3-health, then rerun fleet-sync to reinstall the pinned T3.',
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
        ? `T3 still runs ${running} after ${policy.t3RestartMaxDeferralHours} hours because agent turns kept running. Finish or stop them, or restart ${t3Unit(session)} on the worker (this ends its running turns).`
        : `T3 runs ${running}; ${release} is installed. personal-worker-recovery restarts it at the first check with no agent turn running.`,
    },
  };
}

/** The release installed for the session: the desktop package the app was
 * unpacked from, or the versioned directory the server unit runs. */
async function installedRelease(
  run: Runner,
  session: Session
): Promise<string | undefined> {
  if (session === 'headless') {
    const shown = await run([
      'systemctl',
      '--user',
      'show',
      '--property=ExecStart',
      '--value',
      T3_HEADLESS_UNIT,
    ]);
    return shown.ok
      ? /\/t3-([\w.+-]+?)-linux-[a-z0-9]+\/t3\b/.exec(shown.stdout)?.[1]
      : undefined;
  }
  const installed = await run(['cat', T3_DESKTOP_RELEASE]);
  return /^T3-Code-(.+)-[a-z0-9]+\.deb$/.exec(
    installed.ok ? installed.stdout.trim() : ''
  )?.[1];
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

/** When T3 last started; changes exactly when it restarts. */
export async function t3StartedAt(
  run: Runner,
  session: Session = 'desktop'
): Promise<string> {
  const shown = await run([
    'systemctl',
    '--user',
    'show',
    '--property=ActiveEnterTimestampMonotonic',
    '--value',
    t3Unit(session),
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
