import { powerRecoveryCheck } from './power-recovery';
import { auditUbuntu } from './platform/ubuntu-audit';
import { verifyUbuntuBoot } from './platform/ubuntu-verify';
import { verifyResourceSafety } from './platform/resource-verify';
import policy from '../ansible/ubuntu/policy.json';
import { userInfo } from 'node:os';
import {
  T3_HEALTH_SCRIPT,
  runningVersionCheck,
  t3Unit,
} from './platform/t3-service';
import {
  DEFAULT_FEATURES,
  featuresCheck,
  notApplicable,
  offReason,
  partsOff,
  presentParts,
  type WorkerFeatures,
} from './worker-features';
import { detectMachineClass, type MachineClass } from './machine/machine-class';
import { compareDebianVersions } from './platform/debian-version';
import { packagePins, ubuntuRelease } from './platform/ubuntu-release';
import type { Check, Runner } from './types';

function check(id: string, ok: boolean, summary: string): Check {
  return {
    id,
    status: ok ? 'pass' : 'fail',
    summary,
    ...(!ok
      ? {
          remedy: {
            action:
              'Apply the approved fleet-sync revision over verified SSH, then rerun fleet-status --workers. No password prompt or state reset is attempted by health.',
          },
        }
      : {}),
  };
}
/** A pin is a minimum (docs/worker-contract.md): Ubuntu's security updates
 * may move a package past it, which is reported but never undone. */
export function pinnedPackage(
  name: string,
  pinned: string,
  installed: string | undefined
): Check {
  const order =
    installed === undefined ? -1 : compareDebianVersions(installed, pinned);
  if (order <= 0)
    return check(
      `worker:package:${name}`,
      order === 0,
      order === 0
        ? 'Installed at the version the policy pins.'
        : `PACKAGE_BELOW_PIN ${name} ${installed ?? 'missing'}, pinned ${pinned}`
    );
  return {
    id: `worker:package:${name}`,
    status: 'warn',
    summary: `PACKAGE_NEWER_THAN_PIN ${name} ${installed}, pinned ${pinned}`,
    remedy: {
      action:
        'An unattended security update moved this package past its pin, and it is kept. Raise the pin in the Ubuntu policy when the snapshot moves.',
    },
  };
}

/** Observed unit state for a failed service check, e.g.
 * `SERVICE_NOT_INSTALLED beszel-agent.service (inactive)`. */
export function serviceState(name: string, show: string): string {
  const field = (key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(show)?.[1] ?? '';
  const file = field('UnitFileState');
  const state = field('ActiveState') || 'unknown';
  const code = !file
    ? 'SERVICE_NOT_INSTALLED'
    : state !== 'active'
      ? 'SERVICE_NOT_RUNNING'
      : file !== 'enabled'
        ? 'SERVICE_NOT_ENABLED'
        : 'SERVICE_RESTART_POLICY';
  return `${code} ${name}.service (${state}, unit file ${file || 'missing'}, restart ${field('Restart') || 'unknown'})`;
}

/** Measured runtime evidence, independent of installer receipts. What a
 * worker's declared features leave out, and what its class of machine does
 * not have, is reported as not applicable, with the reason. */
export async function workerHostChecks(
  user: string,
  run: Runner,
  features: WorkerFeatures = DEFAULT_FEATURES,
  powerRecoveryNote?: string
): Promise<Check[]> {
  const audit = await auditUbuntu(run);
  const off = partsOff(features);
  const { machine, virtualization } = await detectMachineClass(run);
  const checks = [
    check(
      'worker:ubuntu',
      audit.supported,
      'Required Ubuntu release and architecture.'
    ),
    check(
      'worker:sudo',
      audit.passwordlessSudo,
      'Designated worker user has noninteractive sudo.'
    ),
    ...Object.entries(packagePins(ubuntuRelease(audit.release))).map(
      ([name, version]) =>
        off.packages.includes(name)
          ? notApplicable(`worker:package:${name}`, offReason(features, name))
          : pinnedPackage(name, version, audit.packages[name])
    ),
    pinnedPackage(
      'tailscale',
      policy.tailscale.version,
      audit.packages['tailscale']
    ),
  ];
  for (const name of policy.alwaysOnServices) {
    if (off.services.includes(name)) {
      checks.push(
        notApplicable(`worker:service:${name}`, offReason(features, name))
      );
      continue;
    }
    const unit = await run([
      'systemctl',
      'show',
      `${name}.service`,
      '--property=UnitFileState,ActiveState,Restart',
    ]);
    const active =
      name === 'beszel-agent'
        ? /^ActiveState=active$/m.test(unit.stdout)
        : audit.services[name] === true;
    const ok =
      unit.ok &&
      active &&
      /^UnitFileState=enabled$/m.test(unit.stdout) &&
      /^Restart=always$/m.test(unit.stdout);
    checks.push(
      check(
        `worker:service:${name}`,
        ok,
        ok
          ? 'Required system service is active, enabled for boot and restarts unconditionally.'
          : serviceState(name, unit.stdout)
      )
    );
  }
  checks.push(await rebootPendingCheck(audit.rebootPending, run));
  checks.push(featuresCheck(features, await presentParts(run, user, features)));
  checks.push(
    ...(await recoveryChecks(run, features, {
      machine,
      virtualization,
      ...(powerRecoveryNote ? { note: powerRecoveryNote } : {}),
    }))
  );
  checks.push(...(await verifyUbuntuBoot(user, run, machine)));
  checks.push(...(await verifyResourceSafety(userInfo().homedir, run)));
  return checks;
}

async function recoveryChecks(
  run: Runner,
  features: WorkerFeatures,
  host: { machine: MachineClass; virtualization: string; note?: string }
): Promise<Check[]> {
  const checks: Check[] = [];
  const t3 = await run([
    'systemctl',
    '--user',
    'show',
    t3Unit(features.session),
    '--property=ActiveState,UnitFileState,Restart',
  ]);
  checks.push(
    check(
      'worker:t3-recovery',
      t3.ok &&
        /^ActiveState=active$/m.test(t3.stdout) &&
        /^UnitFileState=enabled$/m.test(t3.stdout) &&
        /^Restart=(always|on-failure)$/m.test(t3.stdout),
      features.session === 'headless'
        ? 'The T3 server runs as an enabled lingering user service with automatic crash recovery.'
        : 'The T3 desktop app runs as an enabled session service with automatic crash recovery.'
    )
  );
  checks.push(await t3HealthCheck(run));
  checks.push(
    await runningVersionCheck(run, userInfo().uid, Date.now(), features.session)
  );
  const renewal = await run([
    'systemctl',
    '--user',
    'is-active',
    'personal-worker-auth.timer',
  ]);
  checks.push(
    check(
      'worker:credential-renewal',
      renewal.ok,
      'Worker credential renewal timer is active.'
    )
  );
  checks.push(await serviceRecoveryCheck(run));
  checks.push(
    host.machine === 'virtual'
      ? notApplicable(
          'worker:power-loss-recovery',
          `a virtual machine (${host.virtualization}) has no firmware its guest can read, and its provider restarts it after a power loss${host.note ? ` (${host.note})` : ''}`
        )
      : await powerRecoveryCheck(run)
  );
  return checks;
}

/** The recovery timer is active, the script its unit runs exists, and the
 * last run of the unit succeeded: a watchdog that fails on every tick is not
 * recovery. */
export async function serviceRecoveryCheck(run: Runner): Promise<Check> {
  const timer = await run([
    'systemctl',
    '--user',
    'is-active',
    'personal-worker-recovery.timer',
  ]);
  const script = await run(['test', '-r', T3_HEALTH_SCRIPT]);
  const unit = await run([
    'systemctl',
    '--user',
    'show',
    'personal-worker-recovery.service',
    '--property=Result',
  ]);
  const result = /^Result=(.*)$/m.exec(unit.stdout)?.[1] ?? 'unknown';
  const summary = !timer.ok
    ? 'WORKER_RECOVERY_TIMER_INACTIVE'
    : !script.ok
      ? 'WORKER_RECOVERY_SCRIPT_MISSING'
      : !unit.ok || result !== 'success'
        ? `WORKER_RECOVERY_LAST_RUN_FAILED (${/^[\w-]+$/.test(result) ? result : 'unknown'})`
        : 'Worker service recovery timer is active and its last run succeeded.';
  return check(
    'worker:service-recovery',
    timer.ok && script.ok && unit.ok && result === 'success',
    summary
  );
}

/** The server answers its local API now, not merely that a process exists. */
async function t3HealthCheck(run: Runner): Promise<Check> {
  const probe = await run(
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
  let identified = false;
  try {
    const value: unknown = JSON.parse(probe.stdout);
    identified =
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>)['environmentId'] === 'string';
  } catch {
    /* Raw responses are never reported. */
  }
  return check(
    'worker:t3-health',
    probe.ok && identified,
    'T3 local API answers with its environment identity within 10 seconds.'
  );
}

const DAY_SECONDS = 86_400;

/** Kernel and library updates apply only after a reboot. A pending reboot
 * warns with its age, and fails once it is older than `policy.json` allows.
 */
export async function rebootPendingCheck(
  pending: boolean,
  run: Runner,
  now = Date.now()
): Promise<Check> {
  const id = 'worker:reboot-pending';
  if (!pending) return { id, status: 'pass', summary: 'No reboot is pending.' };
  const since = await run(['stat', '-c', '%Y', '/var/run/reboot-required']);
  const seconds = Number(since.stdout.trim());
  const days =
    since.ok && /^\d+$/.test(since.stdout.trim())
      ? Math.max(0, Math.floor((now / 1000 - seconds) / DAY_SECONDS))
      : null;
  const age = days === null ? '' : ` for ${days} days`;
  return {
    id,
    status:
      days !== null && days > policy.rebootPendingFailDays ? 'fail' : 'warn',
    summary: `REBOOT_PENDING${age}: installed updates apply only after a reboot.`,
    remedy: {
      action:
        'Reboot the worker when no agent turn is running (sudo systemctl reboot on the worker), then confirm it returns to ready with devfleet fleet-status --workers.',
    },
  };
}
