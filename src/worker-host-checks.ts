import { powerRecoveryCheck } from './power-recovery';
import { auditUbuntu } from './platform/ubuntu-audit';
import { verifyUbuntuBoot } from './platform/ubuntu-verify';
import { verifyResourceSafety } from './platform/resource-verify';
import policy from '../ansible/ubuntu/policy.json';
import { userInfo } from 'node:os';
import type { Check, Runner } from './types';

function check(id: string, ok: boolean, summary: string): Check {
  return {
    id: `worker:${id}`,
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

/** Measured runtime evidence, independent of installer receipts. */
export async function workerHostChecks(
  user: string,
  run: Runner
): Promise<Check[]> {
  const audit = await auditUbuntu(run);
  const checks = [
    check(
      'ubuntu',
      audit.supported,
      'Required Ubuntu release and architecture.'
    ),
    check(
      'sudo',
      audit.passwordlessSudo,
      'Designated worker user has noninteractive sudo.'
    ),
    ...Object.entries(policy.packages).map(([name, version]) =>
      check(
        `package:${name}`,
        audit.packages[name] === version,
        'Exact declarative Ubuntu package version.'
      )
    ),
  ];
  for (const name of policy.alwaysOnServices) {
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
        `service:${name}`,
        ok,
        ok
          ? 'Required system service is active, enabled for boot and restarts unconditionally.'
          : serviceState(name, unit.stdout)
      )
    );
  }
  checks.push(...(await recoveryChecks(run)));
  checks.push(...(await verifyUbuntuBoot(user, run)));
  checks.push(...(await verifyResourceSafety(userInfo().homedir, run)));
  return checks;
}

async function recoveryChecks(run: Runner): Promise<Check[]> {
  const checks: Check[] = [];
  const t3 = await run([
    'systemctl',
    '--user',
    'show',
    't3code-desktop.service',
    '--property=ActiveState,UnitFileState,Restart',
  ]);
  checks.push(
    check(
      't3-recovery',
      t3.ok &&
        /^ActiveState=active$/m.test(t3.stdout) &&
        /^UnitFileState=enabled$/m.test(t3.stdout) &&
        /^Restart=(always|on-failure)$/m.test(t3.stdout),
      'The T3 desktop app runs as an enabled session service with automatic crash recovery.'
    )
  );
  checks.push(await t3HealthCheck(run));
  const renewal = await run([
    'systemctl',
    '--user',
    'is-active',
    'personal-worker-auth.timer',
  ]);
  const recovery = await run([
    'systemctl',
    '--user',
    'is-active',
    'personal-worker-recovery.timer',
  ]);
  checks.push(
    check(
      'credential-renewal',
      renewal.ok,
      'Worker credential renewal timer is active.'
    )
  );
  checks.push(
    check(
      'service-recovery',
      recovery.ok,
      'Worker service recovery timer is active.'
    )
  );
  checks.push(await powerRecoveryCheck(run));
  return checks;
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
    't3-health',
    probe.ok && identified,
    'T3 local API answers with its environment identity within 10 seconds.'
  );
}
