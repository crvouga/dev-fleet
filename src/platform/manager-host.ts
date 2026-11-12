import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import macos from '../../ansible/macos/policy.json';
import { record } from '../config';
import { hostId } from '../topology';
import { ansibleCommand } from './ansible';
import type { Runner } from '../types';

/** One thing a manager needs to come back by itself after a power cut. */
export interface BootItem {
  item: string;
  /** `fail` stops unattended recovery; `warn` is a trade-off to know about. */
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

/** `notApplicable` names settings the machine lacks (a virtual Mac has no
 * womp): the playbook skips them, so they are not drift.
 */
export interface PowerDrift {
  drifted: string[];
  notApplicable: string[];
}

/** Where the manager runs, behind one interface: how it is named, how it is
 * kept awake, how its services are supervised and where they keep data. The
 * macOS host is the default and the reference.
 */
export interface ManagerHost {
  platform: 'macOS' | 'linux';
  serviceManager: 'launchd' | 'systemd';
  containerEngine: 'Docker Desktop' | 'Docker Engine';
  /** The Tailscale command line. */
  tailscale: string[];
  /** Where the manager's services keep their data. */
  dataDirectory(home: string): string;
  /** The machine's local host name, as `manager.id` must name it. */
  localHostName(run: Runner): Promise<string | null>;
  /** The power settings that differ from the manager's policy, and those
   * this machine does not have at all. */
  powerDrift(run: Runner): Promise<PowerDrift>;
  /** What brings the manager's services back after a power cut, unattended. */
  bootRecovery(run: Runner, home: string): Promise<BootItem[]>;
  /** How a person applies what bootRecovery measures. */
  bootRemedy(workspace: string): string;
}

const item = (
  name: string,
  ok: boolean,
  [pass, failure, status = 'fail']: [string, string, ('warn' | 'fail')?]
): BootItem => ({
  item: name,
  status: ok ? 'pass' : status,
  detail: ok ? pass : failure,
});

/** `pmset -g custom`'s AC Power section, as key and value. */
async function acPower(
  run: Runner
): Promise<(key: string) => string | undefined> {
  const result = await run(['pmset', '-g', 'custom']);
  const ac = result.ok ? (result.stdout.split('AC Power:')[1] ?? '') : '';
  return (key) => new RegExp(`^\\s*${key}\\s+(\\S+)`, 'm').exec(ac)?.[1];
}

function dockerSettings(home: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(home, macos.dockerDesktop.settings), 'utf8')
    );
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

export const MACOS_MANAGER: ManagerHost = {
  platform: 'macOS',
  serviceManager: 'launchd',
  containerEngine: 'Docker Desktop',
  tailscale: ['tailscale'],
  dataDirectory: (home) => join(home, 'Library/Application Support'),
  async localHostName(run) {
    const result = await run(['scutil', '--get', 'LocalHostName']);
    return result.ok ? hostId(result.stdout.trim()) : null;
  },
  async powerDrift(run) {
    const result = await run(['pmset', '-g', 'custom']);
    const ac = result.ok ? result.stdout.split('AC Power:')[1] : undefined;
    const observed = (key: string) =>
      new RegExp(`^\\s*${key}\\s+(\\S+)`, 'm').exec(ac ?? '')?.[1];
    const absent = (key: string) =>
      ac !== undefined && observed(key) === undefined;
    return {
      drifted: Object.entries(macos.pmset)
        .filter(([key, value]) => !absent(key) && observed(key) !== value)
        .map(([key]) => key),
      notApplicable: Object.keys(macos.pmset).filter(absent),
    };
  },
  async bootRecovery(run, home) {
    const observed = await acPower(run);
    const docker = dockerSettings(home);
    const vault = await run(['fdesetup', 'status']);
    const filevault = vault.ok && /FileVault is On/.test(vault.stdout);
    const login = await run([
      'defaults',
      'read',
      '/Library/Preferences/com.apple.loginwindow',
      'autoLoginUser',
    ]);
    const agent = await run([
      'launchctl',
      'print',
      `gui/${userInfo().uid}/${macos.beszelDaemon}`,
    ]);
    return [
      item('autorestart', observed('autorestart') === macos.pmset.autorestart, [
        'The Mac starts again by itself when power returns.',
        'The Mac stays off after a power cut (pmset autorestart is not 1).',
      ]),
      item('docker-autostart', docker?.[macos.dockerDesktop.key] === true, [
        'Docker Desktop starts at login, and with it the proxy and the hub.',
        'Docker Desktop does not start at login: the CLI proxy and the monitoring hub stay down after a restart.',
      ]),
      filevault
        ? item('login', false, [
            '',
            'FileVault is on: after a restart the Mac waits at the login window until a person signs in, and no LaunchAgent or Docker Desktop starts before that. Turn FileVault off for unattended recovery, or accept that a power cut needs a person (docs/manager-recovery.md).',
            'warn',
          ])
        : item('login', login.ok && login.stdout.trim().length > 0, [
            'FileVault is off and a user signs in automatically after a restart.',
            'No user signs in automatically after a restart, so no LaunchAgent starts. Turn on automatic login for the manager’s user in System Settings (it asks for that user’s password).',
            'warn',
          ]),
      item('launch-agents', agent.ok, [
        'The fleet’s LaunchAgents are loaded.',
        `The LaunchAgent ${macos.beszelDaemon} is not loaded.`,
      ]),
    ];
  },
  bootRemedy: (workspace) =>
    `Apply the manager policy, as an administrator: cd ${workspace} && ${ansibleCommand('darwin').join(' ')} -K ansible/macos/manager.yml (autorestart, Docker Desktop at login), then fleet-sync (LaunchAgents). FileVault and automatic login are a person’s choice: docs/manager-recovery.md.`,
};

/** The sleep states a Linux manager must never enter. */
const SLEEP_TARGETS = [
  'sleep.target',
  'suspend.target',
  'hibernate.target',
  'hybrid-sleep.target',
];

export const LINUX_MANAGER: ManagerHost = {
  platform: 'linux',
  serviceManager: 'systemd',
  containerEngine: 'Docker Engine',
  tailscale: ['tailscale'],
  dataDirectory: (home) => join(home, '.local/share'),
  async localHostName(run) {
    const result = await run(['hostnamectl', '--static']);
    return result.ok ? hostId(result.stdout.trim()) : null;
  },
  async powerDrift(run) {
    const drifted: string[] = [];
    for (const target of SLEEP_TARGETS) {
      const result = await run(['systemctl', 'is-enabled', target]);
      if (result.stdout.trim() !== 'masked') drifted.push(target);
    }
    return { drifted, notApplicable: [] };
  },
  async bootRecovery(run) {
    const user = userInfo().username;
    const linger = await run([
      'loginctl',
      'show-user',
      user,
      '--property=Linger',
    ]);
    const docker = await run(['systemctl', 'is-enabled', 'docker.service']);
    return [
      item('linger', linger.stdout.trim() === 'Linger=yes', [
        'The manager’s user services start at boot, without a login.',
        'The manager’s user services wait for a login (loginctl linger is off).',
      ]),
      item('docker-autostart', docker.stdout.trim() === 'enabled', [
        'Docker Engine starts at boot, and with it the proxy and the hub.',
        'Docker Engine does not start at boot: the CLI proxy and the monitoring hub stay down after a restart.',
      ]),
    ];
  },
  bootRemedy: () =>
    'Enable lingering for the manager’s user and the docker service with the Linux manager policy; a Linux manager role is not shipped yet.',
};

export function managerHost(platform: 'macOS' | 'linux'): ManagerHost {
  return platform === 'linux' ? LINUX_MANAGER : MACOS_MANAGER;
}
