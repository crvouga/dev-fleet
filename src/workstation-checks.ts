import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, Runner } from './types';

/** This machine has the `devfleet` launcher, linked into a checkout. */
export async function workstationChecks(
  _root: string,
  run: Runner
): Promise<Check[]> {
  const launcher = join(homedir(), '.local/bin/devfleet');
  const result = await run(['test', '-x', launcher], { timeoutMs: 5_000 });
  return [
    result.ok
      ? {
          id: 'workstation:configuration',
          status: 'pass',
          summary: 'The devfleet launcher is installed.',
        }
      : {
          id: 'workstation:configuration',
          status: 'fail',
          summary: 'The devfleet launcher is missing.',
          remedy: {
            action:
              'Run fleet-sync from the manager: it links the launcher to the checkout of the revision it applies.',
          },
        },
  ];
}
