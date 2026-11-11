import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type {
  NotifierTestResult,
  ScheduledJob,
  ScheduledJobStatus,
} from './types';

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function launchAgentPath(label: string, home = homedir()): string {
  return join(home, 'Library/LaunchAgents', `${label}.plist`);
}

/** launchd agent plist for a periodic job. Pure — unit-tested. */
export function launchdPlist(job: ScheduledJob): string {
  const args = job.command.map((a) => `    <string>${xml(a)}</string>`);
  const env = Object.entries(job.env).map(
    ([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${xml(job.label)}</string>`,
    '  <key>ProgramArguments</key><array>',
    ...args,
    '  </array>',
    '  <key>EnvironmentVariables</key><dict>',
    ...env,
    '  </dict>',
    `  <key>StartInterval</key><integer>${job.intervalSeconds}</integer>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>LowPriorityIO</key><true/>',
    '  <key>Nice</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(join(job.logDir, `${job.label}.out.log`))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(join(job.logDir, `${job.label}.err.log`))}</string>`,
    '</dict></plist>',
    '',
  ].join('\n');
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

export function installLaunchdJob(job: ScheduledJob): NotifierTestResult {
  const plist = launchAgentPath(job.label);
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(job.logDir, { recursive: true });
  writeFileSync(plist, launchdPlist(job));
  spawnSync('launchctl', ['bootout', `${domain()}/${job.label}`], {
    stdio: 'ignore',
  });
  const r = spawnSync('launchctl', ['bootstrap', domain(), plist], {
    encoding: 'utf8',
  });
  return r.status === 0
    ? { ok: true, detail: `launchd agent ${plist}` }
    : { ok: false, detail: `launchctl bootstrap failed: ${r.stderr.trim()}` };
}

export function removeLaunchdJob(label: string): NotifierTestResult {
  spawnSync('launchctl', ['bootout', `${domain()}/${label}`], {
    stdio: 'ignore',
  });
  rmSync(launchAgentPath(label), { force: true });
  return { ok: true, detail: `removed launchd agent ${label}` };
}

export function launchdJobStatus(label: string): ScheduledJobStatus {
  const r = spawnSync('launchctl', ['print', `${domain()}/${label}`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const present = existsSync(launchAgentPath(label));
    return {
      supported: true,
      installed: false,
      detail: present ? 'plist present but not loaded' : 'not installed',
    };
  }
  const lastExit =
    /last exit code = (.+)/.exec(r.stdout)?.[1]?.trim() ?? 'unknown';
  return {
    supported: true,
    installed: true,
    detail: `loaded; last exit code ${lastExit}`,
  };
}
