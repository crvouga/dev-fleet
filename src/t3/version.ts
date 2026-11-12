import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sshArgs } from '../ssh';
import type { Check, FleetNode, Runner } from '../types';

/** The T3 release every machine runs: `t3_version` in mise.toml. */
export async function pinnedT3Version(workspace: string): Promise<string> {
  const toml = await readFile(join(workspace, 'mise.toml'), 'utf8');
  const version = /^t3_version = "([^"]+)"$/m.exec(toml)?.[1];
  if (!version) throw new Error('mise.toml pins no T3 version.');
  return version;
}

/** Where T3 notes the version it last started as, under its home. */
export const STARTED_VERSION = 'userdata/desktop-last-started-version';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** `t3:version`: the T3 a machine runs is the one the fleet pins, so the
 * manager and the workers it drives never run different releases.
 */
export function versionCheck(
  running: string | null,
  pinned: string,
  where: string,
  install: string
): Check {
  const observed = running?.trim() ?? '';
  if (!VERSION.test(observed))
    return {
      id: 't3:version',
      status: 'warn',
      summary: 'T3_VERSION_UNKNOWN',
      remedy: {
        action: `T3 on ${where} has not recorded the version it runs. Start T3 there once, then run fleet-sync.`,
      },
    };
  if (observed !== pinned)
    return {
      id: 't3:version',
      status: 'warn',
      summary: 'T3_VERSION_SKEW',
      remedy: {
        action: `T3 on ${where} runs ${observed}; the fleet pins ${pinned}. ${install}`,
      },
    };
  return {
    id: 't3:version',
    status: 'pass',
    summary: `T3 on ${where} runs ${pinned}, the release every machine runs.`,
  };
}

export async function managerVersion(
  t3Home: string,
  workspace: string
): Promise<Check> {
  const running = await readFile(join(t3Home, STARTED_VERSION), 'utf8').catch(
    () => null
  );
  return versionCheck(
    running,
    await pinnedT3Version(workspace),
    'the manager',
    'Install that release of T3 Code on the manager. With the fleet policy staged (ansible-playbook -e user=$(id -un) -K ansible/macos/manager-privilege.yml) it no longer updates itself.'
  );
}

export async function workerVersion(
  node: FleetNode,
  run: Runner,
  workspace: string
): Promise<Check> {
  const result = await run(
    [...sshArgs(node), `cat "$HOME/.t3/${STARTED_VERSION}"`],
    { timeoutMs: 15_000 }
  );
  return versionCheck(
    result.ok ? result.stdout : null,
    await pinnedT3Version(workspace),
    `worker ${node.id}`,
    'Run fleet-sync for that worker: it installs the pinned desktop app and restarts T3 when its policy changed.'
  );
}

/** Where T3 on macOS reads its administrator policy. */
export const MACOS_POLICY = '/Library/Application Support/T3Code/policy.json';

/** `t3:updates`: T3's own updater is off by the fleet's policy, so it changes
 * only when the pin does.
 */
export async function updatesCheck(
  policyPath: string,
  stage: string
): Promise<Check> {
  let mode: unknown;
  try {
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
      limits?: { updates?: { mode?: unknown } };
    };
    mode = policy.limits?.updates?.mode;
  } catch {
    mode = undefined;
  }
  return mode === 'off'
    ? {
        id: 't3:updates',
        status: 'pass',
        summary: 'T3’s own updater is off by the fleet’s policy.',
      }
    : {
        id: 't3:updates',
        status: 'warn',
        summary: 'T3_UPDATES_UNMANAGED',
        remedy: {
          action: `T3 on this machine may update itself away from the pinned release. Stage the fleet's policy once, as an administrator: ${stage}`,
        },
      };
}
