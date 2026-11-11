import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  NotifierTestResult,
  ScheduledJob,
  ScheduledJobStatus,
} from './types';

function unitDir(): string {
  const base =
    process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(base, 'systemd/user');
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg)
    ? arg
    : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** systemd user service + timer for a periodic job. Pure — unit-tested. */
export function systemdUnits(job: ScheduledJob): {
  service: string;
  timer: string;
} {
  const env = Object.entries(job.env).map(
    ([k, v]) => `Environment=${quote(`${k}=${v}`)}`
  );
  const service = [
    '[Unit]',
    `Description=${job.label}`,
    '',
    '[Service]',
    'Type=oneshot',
    'Nice=10',
    ...env,
    `ExecStart=${job.command.map(quote).join(' ')}`,
    `StandardOutput=append:${join(job.logDir, `${job.label}.out.log`)}`,
    `StandardError=append:${join(job.logDir, `${job.label}.err.log`)}`,
    '',
  ].join('\n');
  const timer = [
    '[Unit]',
    `Description=${job.label} every ${job.intervalSeconds}s`,
    '',
    '[Timer]',
    'OnBootSec=60',
    `OnUnitActiveSec=${job.intervalSeconds}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return { service, timer };
}

function systemctl(args: readonly string[]): { ok: boolean; out: string } {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
  };
}

export function installSystemdJob(job: ScheduledJob): NotifierTestResult {
  const dir = unitDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(job.logDir, { recursive: true });
  const { service, timer } = systemdUnits(job);
  writeFileSync(join(dir, `${job.label}.service`), service);
  writeFileSync(join(dir, `${job.label}.timer`), timer);
  systemctl(['daemon-reload']);
  const r = systemctl(['enable', '--now', `${job.label}.timer`]);
  return r.ok
    ? { ok: true, detail: `systemd user timer ${job.label}.timer` }
    : { ok: false, detail: `systemctl --user enable failed: ${r.out}` };
}

export function removeSystemdJob(label: string): NotifierTestResult {
  systemctl(['disable', '--now', `${label}.timer`]);
  rmSync(join(unitDir(), `${label}.timer`), { force: true });
  rmSync(join(unitDir(), `${label}.service`), { force: true });
  systemctl(['daemon-reload']);
  return { ok: true, detail: `removed systemd user timer ${label}` };
}

export function systemdJobStatus(label: string): ScheduledJobStatus {
  const r = systemctl(['is-active', `${label}.timer`]);
  return r.ok
    ? { supported: true, installed: true, detail: 'timer active' }
    : { supported: true, installed: false, detail: r.out || 'not installed' };
}
