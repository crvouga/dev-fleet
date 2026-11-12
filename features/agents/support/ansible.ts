import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentsPlay, type ProfilePlay } from '../../../src/agents/converge';
import { ansibleCommand } from '../../../src/platform/ansible';
import { runCommand } from '../../../src/runner';
import type { CommandResult } from '../../../src/types';
import type { World } from '../../support/gherkin';

const checkout = resolve(import.meta.dir, '../../..');

/** Scenarios tagged @ansible run the real agents play with the Ansible the
 * manager runs (the locked project in ansible/). They are skipped where uv
 * is missing, except where DEVFLEET_TEST_ANSIBLE=required (CI), where a
 * missing uv fails them instead.
 */
export const ansibleAvailable =
  process.env['DEVFLEET_TEST_ANSIBLE'] === 'required' ||
  spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;

/** One run of the play, as the scenario observes it. */
export interface PlayRun {
  result: CommandResult;
  check: boolean;
}

/** The package's agents play, run by the locked Ansible on any platform (a
 * worker's pinned ansible-playbook package is not on a test machine). Its
 * variables file, Ansible's own state and temporary files are kept in a
 * directory of the scenario's, never under the home directory.
 */
export async function lockedPlay(
  world: World,
  runs: PlayRun[],
  options: { check?: boolean } = {}
): Promise<ProfilePlay> {
  const scratch = await mkdtemp(join(tmpdir(), 'agents-play-'));
  world.defer(() => rm(scratch, { recursive: true, force: true }));
  const play = agentsPlay(
    (command, commandOptions) => {
      const playbook = command.indexOf('ansible-playbook');
      return runCommand(
        [...ansibleCommand('darwin', checkout), ...command.slice(playbook + 1)],
        {
          ...commandOptions,
          env: {
            ...commandOptions?.env,
            ANSIBLE_HOME: join(scratch, 'ansible'),
            ANSIBLE_LOCAL_TEMP: join(scratch, 'tmp'),
            ANSIBLE_NOCOLOR: '1',
          },
        }
      );
    },
    { scratch: join(scratch, 'run'), check: options.check === true }
  );
  return async (variables) => {
    const result = await play(variables);
    runs.push({ result, check: options.check === true });
    return result;
  };
}

/** What the recap of a run says changed, or null when it has none. */
export function changedCount(result: CommandResult): number | null {
  const counts = [...result.stdout.matchAll(/changed=(\d+)/g)];
  const last = counts.at(-1);
  return last ? Number(last[1]) : null;
}
