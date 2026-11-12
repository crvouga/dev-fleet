import type { Command } from 'commander';
import { hostname } from 'node:os';
import { FleetUsageError } from '../errors';
import { fleet } from '../fleet-config';
import { githubPolicy } from '../github/policy';
import { verifyGithubWorkflow } from '../github/workflow';
import { runCommand } from '../runner';
import { hostId } from '../topology';
import type { Runner } from '../types';
import type { CommandOutcome } from './contracts';

/** Runs the GitHub workflow an agent depends on from this machine against
 * the declared sandbox repository, and cleans up after itself.
 */
export async function githubVerify(
  run: Runner = runCommand,
  node = hostId(hostname())
): Promise<CommandOutcome> {
  const sandbox = githubPolicy(fleet).sandbox;
  if (!sandbox)
    throw new FleetUsageError(
      'No sandbox repository. Declare github.sandbox ("owner/name") in fleet.json: a repository the fleet login may branch, push to and open pull requests on.'
    );
  const result = await verifyGithubWorkflow({ run, sandbox, node });
  const ok = result.check.status === 'pass';
  return {
    exitCode: ok ? 0 : 1,
    data: {
      version: 1,
      command: 'github-verify',
      ok,
      node,
      checks: [result.check],
      ...(result.failed ? { failedStep: result.failed } : {}),
      leftBehind: result.leftBehind,
    },
    text: `${result.check.id} ${result.check.status}: ${result.check.summary}`,
  };
}

export function registerGithubVerify(
  program: Command,
  complete: (outcome: CommandOutcome) => void
): void {
  program
    .command('fleet-github-verify')
    .description(
      'Prove this machine can clone, push, open a pull request, read checks and comment on GitHub'
    )
    .addHelpText(
      'after',
      '\nWorks on the sandbox repository named by github.sandbox in fleet.json: a uniquely named branch and a draft pull request, both closed and deleted again by the same run, whatever failed.'
    )
    .action(async () => {
      complete(await githubVerify());
    });
}
