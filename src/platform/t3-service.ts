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
