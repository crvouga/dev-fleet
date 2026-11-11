import { FleetUsageError } from '../errors';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';
import { t3Command } from './t3/command';
import type { T3Options } from '../t3/desired';

export async function syncT3(
  options: T3Options,
  settings: Settings
): Promise<CommandOutcome> {
  try {
    return await t3Command('t3-apply', options, settings);
  } catch (error) {
    return {
      exitCode: 1,
      data: {
        version: 1,
        command: 'fleet-node-sync',
        ok: false,
        applied: true,
        stage: 't3',
        error:
          error instanceof FleetUsageError
            ? error.message
            : 'T3 reconciliation failed; inspect local configuration and ownership state.',
        progress:
          'Tools, launcher and profile steps completed. Node receipt was not advanced. Fix the T3 conflict and repeat fleet-node-sync.',
      },
    };
  }
}
