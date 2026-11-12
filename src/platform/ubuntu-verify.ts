import type { Check, Runner } from '../types';
import type { MachineClass } from '../machine/machine-class';

/** What a lid does: a virtual machine has none, so these do not apply. */
const LID = {
  HandleLidSwitch: 's "ignore"',
  HandleLidSwitchDocked: 's "ignore"',
  HandleLidSwitchExternalPower: 's "ignore"',
};
const LOGIND = {
  IdleAction: 's "ignore"',
  KillUserProcesses: 'b false',
  StopIdleSessionUSec: 't 18446744073709551615',
};
const POWER_FILES = [
  '/etc/systemd/logind.conf.d/60-personal-fleet.conf',
  '/etc/systemd/sleep.conf.d/60-personal-fleet.conf',
];
/** Inspect the running manager, not an installer receipt. Reboot acceptance
 * additionally requires the managed files to predate this kernel boot.
 */
export async function verifyUbuntuBoot(
  user: string,
  run: Runner,
  machine: MachineClass = 'physical'
): Promise<Check[]> {
  const virtual = machine === 'virtual';
  // On a virtual machine the lid policy is not applicable; the sleep masks
  // stay, since a guest can still be suspended by its own idle policy.
  const lid: Check[] = virtual
    ? [
        {
          id: 'ubuntu:lid-policy',
          status: 'not-applicable',
          summary: 'Not applicable: a virtual machine has no lid.',
        },
      ]
    : [];
  return [
    ...lid,
    ...(await bootPolicy(user, run, virtual ? LOGIND : { ...LID, ...LOGIND })),
  ];
}

async function bootPolicy(
  user: string,
  run: Runner,
  properties: Record<string, string>
): Promise<Check[]> {
  for (const [property, expected] of Object.entries(properties)) {
    const observed = await run([
      'busctl',
      'get-property',
      'org.freedesktop.login1',
      '/org/freedesktop/login1',
      'org.freedesktop.login1.Manager',
      property,
    ]);
    if (!observed.ok || observed.stdout.trim() !== expected)
      return pending(
        'UBUNTU_SESSION_POLICY_PENDING',
        'The running login manager does not expose the declared ' +
          property +
          '. Keep active work intact and schedule an explicit maintenance reboot; do not restart logind during sessions.'
      );
  }
  for (const name of [
    'sleep',
    'suspend',
    'hibernate',
    'hybrid-sleep',
    'suspend-then-hibernate',
  ]) {
    const observed = await run(['systemctl', 'is-enabled', name + '.target']);
    if (observed.stdout.trim() !== 'masked')
      return pending(
        'UBUNTU_SLEEP_POLICY_DRIFT',
        'A declared sleep transition is not masked. Reapply the approved Ubuntu baseline; preserve user sessions.'
      );
  }
  const linger = await run([
    'loginctl',
    'show-user',
    user,
    '--property=Linger',
    '--value',
  ]);
  if (!linger.ok || linger.stdout.trim() !== 'yes')
    return pending(
      'UBUNTU_LINGER_REQUIRED',
      'The designated user is not observed as lingering. Reapply the approved user policy before claiming logout survival.'
    );
  if (!(await filesPredateBoot(run)))
    return pending(
      'UBUNTU_MAINTENANCE_REBOOT_PENDING',
      'Effective session policy matches, but the managed power files were not observed before this boot. Perform an explicit maintenance reboot and rerun the manager command.'
    );
  return [
    {
      id: 'ubuntu:boot-policy',
      status: 'pass',
      summary:
        'Managed power files predate this boot; the running login manager exposes the declared no-sleep/session policy, sleep transitions are masked, and designated-user lingering is active.',
    },
  ];
}
async function filesPredateBoot(run: Runner): Promise<boolean> {
  const boot = await run(['cat', '/proc/stat']);
  const seconds = Number(/^btime (\d+)$/m.exec(boot.stdout)?.[1]);
  if (!boot.ok || !Number.isSafeInteger(seconds) || seconds <= 0) return false;
  for (const path of POWER_FILES) {
    const observed = await run(['stat', '--format=%Y', path]);
    const modified = Number(observed.stdout.trim());
    if (
      !observed.ok ||
      !Number.isSafeInteger(modified) ||
      modified <= 0 ||
      modified >= seconds
    )
      return false;
  }
  return true;
}
function pending(code: string, action: string): Check[] {
  return [
    {
      id: 'ubuntu:boot-policy',
      status: 'fail',
      summary: code,
      remedy: { action },
    },
  ];
}
