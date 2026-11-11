import { join } from 'node:path';
import { currentPlatform } from '../platform';
import type { Platform } from '../platform/types';
import type { Runner } from '../types';
import type { CommandOutcome } from './contracts';
import { machineRoot } from './fleet-sync';

const LABEL = 'personal-fleet-sync';
declare const PERSONAL_VERSION: string | undefined;
declare const PERSONAL_SOURCE_REVISION: string | null;
export type ScheduleAction =
  'enable' | 'pause' | 'resume' | 'disable' | 'status';
interface ScheduleInput {
  action: ScheduleAction;
  revision: string;
  config: string;
  authorized: boolean;
}
export async function managerSchedule(
  input: ScheduleInput,
  run: Runner,
  platform: Platform = currentPlatform()
): Promise<CommandOutcome> {
  if (input.action === 'status')
    return {
      exitCode: 0,
      data: {
        version: 2,
        command: 'fleet-sync',
        execution: 'manager-push',
        scheduling: scheduleStatus(platform),
      },
    };
  if (!input.authorized)
    return required('Manager scheduling changes require --apply --yes.');
  if (input.action === 'pause' || input.action === 'disable')
    return removeSchedule(input, platform);
  return enableSchedule(input, run, platform);
}
function removeSchedule(
  input: ScheduleInput,
  platform: Platform
): CommandOutcome {
  const result = platform.removeScheduledJob(LABEL);
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
  if (
    typeof PERSONAL_VERSION !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(PERSONAL_VERSION) ||
    typeof PERSONAL_SOURCE_REVISION !== 'string'
  )
    return required(
      'Scheduling requires a published CLI with clean source provenance; dirty review artifacts cannot enable unattended deployment.'
    );
  const root = machineRoot();
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
      `dev-fleet@${PERSONAL_VERSION}`,
    ],
    { timeoutMs: 120_000 }
  );
  if (!installed.ok)
    return required(
      'The exact CLI package could not be installed in the managed manager runtime. No schedule was enabled.'
    );
  const result = platform.installScheduledJob({
    label: LABEL,
    intervalSeconds: 1800,
    command: [
      process.execPath,
      join(prefix, 'node_modules/dev-fleet/cli.mjs'),
      'fleet-sync',
      '--config',
      input.config,
      '--revision',
      input.revision,
      '--apply',
      '--yes',
      '--non-interactive',
      '--json',
    ],
    logDir: join(root, 'logs'),
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
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
