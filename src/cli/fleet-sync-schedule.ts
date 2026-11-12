import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentPlatform } from '../platform';
import type { Platform } from '../platform/types';
import { PACKAGE_ROOT, packageInfo, type PackageInfo } from '../package-info';
import {
  readHistory,
  recordSchedule,
  type ScheduleRecord,
} from '../state/history';
import { scheduleCheck, SCHEDULE_INTERVAL_SECONDS } from '../schedule-check';
import type { Runner } from '../types';
import type { CommandOutcome } from './contracts';
import { machineRoot } from './fleet-sync';

/** The launchd label and systemd unit already on running managers. */
export const SCHEDULE_LABEL = 'personal-fleet-sync';
const LABEL = SCHEDULE_LABEL;
export type ScheduleAction =
  'enable' | 'pause' | 'resume' | 'disable' | 'status';
interface ScheduleInput {
  action: ScheduleAction;
  revision: string;
  config: string;
  authorized: boolean;
  /** The package this CLI runs from; the schedule installs the same one. */
  release?: Release;
  /** Where the schedule is recorded in the fleet state; tests replace it. */
  record?: (schedule: ScheduleRecord) => void;
  /** The manager's caches; tests name their own. */
  root?: string;
  now?: Date;
}

/** The published package a schedule installs and runs: its name, exact
 * version and the entry point its manifest declares.
 */
export interface Release extends PackageInfo {
  bin: string | null;
}

export function release(root = PACKAGE_ROOT): Release {
  let bin: unknown = null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    ) as { bin?: unknown };
    bin = typeof manifest.bin === 'string' ? manifest.bin : null;
    if (typeof manifest.bin === 'object' && manifest.bin !== null)
      bin = (manifest.bin as Record<string, unknown>)['devfleet'] ?? null;
  } catch {
    bin = null;
  }
  return {
    ...packageInfo(root),
    bin: typeof bin === 'string' ? bin.replace(/^\.\//, '') : null,
  };
}

/** Only a published release can be scheduled: it names an exact version and
 * the commit it was built from, so every unattended run is the same code.
 */
export function publishedRelease(release: Release): boolean {
  return (
    /^\d+\.\d+\.\d+$/.test(release.version) &&
    release.revision !== null &&
    release.bin !== null &&
    !release.bin.split('/').includes('..')
  );
}

/** What launchd (or the systemd timer) runs: the installed package's own
 * entry point under Node, with the tools fleet-sync installs on PATH. No path
 * into the project or the package the operator ran is written into it.
 */
export function scheduledCommand(
  release: Release,
  revision: string,
  prefix: string
): string[] {
  return [
    '/usr/bin/env',
    'node',
    join(prefix, 'node_modules', release.name, release.bin ?? ''),
    'fleet-sync',
    '--revision',
    revision,
    '--apply',
    '--yes',
    '--non-interactive',
    '--json',
  ];
}

export function scheduledEnvironment(home = homedir()): Record<string, string> {
  return {
    PATH: [
      join(home, '.local/share/mise/shims'),
      join(home, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
    DEVFLEET_TRIGGER: 'schedule',
  };
}

export async function managerSchedule(
  input: ScheduleInput,
  run: Runner,
  platform: Platform = currentPlatform()
): Promise<CommandOutcome> {
  if (input.action === 'status') return statusReport(platform, input.now);
  if (!input.authorized)
    return required('Manager scheduling changes require --apply --yes.');
  if (input.action === 'pause' || input.action === 'disable')
    return removeSchedule(input, platform);
  return enableSchedule(input, run, platform);
}

function statusReport(platform: Platform, now = new Date()): CommandOutcome {
  const history = readHistory();
  const check = scheduleCheck(history, now);
  return {
    exitCode: 0,
    data: {
      version: 2,
      command: 'fleet-sync',
      execution: 'manager-push',
      scheduling: scheduleStatus(platform),
      intervalSeconds:
        history.schedule?.intervalSeconds ?? SCHEDULE_INTERVAL_SECONDS,
      runs: history.runs
        .filter((entry) => entry.trigger === 'schedule')
        .slice(-3)
        .reverse(),
      ...(check ? { checks: [check] } : {}),
    },
  };
}

function remember(
  input: ScheduleInput,
  enabled: boolean,
  intervalSeconds = SCHEDULE_INTERVAL_SECONDS
): void {
  try {
    (input.record ?? recordSchedule)({
      enabled,
      intervalSeconds,
      changedAt: (input.now ?? new Date()).toISOString(),
    });
  } catch {
    // The schedule changed either way; the next run records it again.
  }
}

function removeSchedule(
  input: ScheduleInput,
  platform: Platform
): CommandOutcome {
  const result = platform.removeScheduledJob(LABEL);
  if (result.ok) remember(input, false);
  return {
    exitCode: result.ok ? 0 : 1,
    data: {
      version: 2,
      command: 'fleet-sync',
      ok: result.ok,
      scheduling: input.action,
      summary: result.ok
        ? 'Manager schedule removed; node application services are untouched.'
        : 'Manager scheduler removal failed; inspect its platform status.',
    },
  };
}
async function enableSchedule(
  input: ScheduleInput,
  run: Runner,
  platform: Platform
): Promise<CommandOutcome> {
  const published = input.release ?? release();
  if (!publishedRelease(published))
    return required(
      'Scheduling requires a published CLI with clean source provenance; dirty review artifacts cannot enable unattended deployment.'
    );
  const root = input.root ?? machineRoot();
  const prefix = join(root, 'runtime');
  const installed = await run(
    [
      'npm',
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${published.name}@${published.version}`,
    ],
    { timeoutMs: 120_000 }
  );
  if (!installed.ok)
    return required(
      'The exact CLI package could not be installed in the managed manager runtime. No schedule was enabled.'
    );
  const result = platform.installScheduledJob({
    label: LABEL,
    intervalSeconds: SCHEDULE_INTERVAL_SECONDS,
    command: scheduledCommand(published, input.revision, prefix),
    logDir: join(root, 'logs'),
    env: scheduledEnvironment(),
  });
  if (result.ok) remember(input, true);
  return {
    exitCode: result.ok ? 0 : 1,
    data: {
      version: 2,
      command: 'fleet-sync',
      ok: result.ok,
      scheduling: result.ok ? 'enabled' : 'action-required',
      revision: input.revision,
      summary:
        'Manager schedule uses one exact package and approved revision. Linux user scheduling requires lingering; macOS LaunchAgent requires the manager user session. Inspect status and logs; boot acceptance is separate.',
    },
  };
}
function required(summary: string): CommandOutcome {
  return {
    exitCode: 1,
    data: {
      version: 2,
      command: 'fleet-sync',
      ok: false,
      scheduling: 'action-required',
      summary,
    },
  };
}

function scheduleStatus(platform: Platform) {
  const { installed, supported } = platform.scheduledJobStatus(LABEL);
  return { installed, supported };
}
