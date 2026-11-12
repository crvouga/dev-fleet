import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check, Runner } from '../types';

/** The steps of the work an agent does on GitHub, in order. A failure names
 * the first step that failed.
 */
export const WORKFLOW_STEPS = [
  'clone',
  'branch',
  'commit',
  'push',
  'pull-request',
  'read-checks',
  'comment',
] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface WorkflowInput {
  run: Runner;
  /** `owner/name` of the declared sandbox repository. */
  sandbox: string;
  /** The node that runs it: part of the branch name. */
  node: string;
  /** A unique suffix for the branch; time and randomness by default. */
  unique?: string;
  /** A private, empty directory for the clone; made and removed by default. */
  directory?: string;
}

export interface WorkflowResult {
  check: Check;
  /** The step that failed, if one did. */
  failed?: WorkflowStep;
  /** The branch the run used, deleted again unless `leftBehind`. */
  branch: string;
  /** What clean-up could not remove: a branch or a pull request. */
  leftBehind: string[];
}

const STEP_TIMEOUT_MS = 60_000;

/** Runs the chain an agent depends on against the sandbox repository: clone,
 * branch, commit with the configured identity, push, open a draft pull
 * request, read its checks, comment; then always closes the pull request and
 * deletes the branch, whatever failed. Every step is bounded.
 */
export async function verifyGithubWorkflow(
  input: WorkflowInput
): Promise<WorkflowResult> {
  const { run, sandbox, node } = input;
  const unique =
    input.unique ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `devfleet-verify/${node}-${unique}`;
  const directory =
    input.directory ?? (await mkdtemp(join(tmpdir(), 'devfleet-verify-')));
  const clone = join(directory, 'sandbox');
  const git = (args: string[]) =>
    run(['git', '-C', clone, ...args], { timeoutMs: STEP_TIMEOUT_MS });
  const gh = (args: string[]) =>
    run(['gh', ...args], { timeoutMs: STEP_TIMEOUT_MS });
  let failed: WorkflowStep | undefined;
  let pushed = false;
  let pullRequest: string | null = null;
  const leftBehind: string[] = [];
  const step = async (
    name: WorkflowStep,
    action: () => Promise<boolean>
  ): Promise<boolean> => {
    if (failed) return false;
    if (await action()) return true;
    failed = name;
    return false;
  };
  try {
    await step('clone', async () => {
      const result = await run(
        [
          'git',
          'clone',
          '--depth',
          '1',
          `https://github.com/${sandbox}.git`,
          clone,
        ],
        { timeoutMs: STEP_TIMEOUT_MS }
      );
      return result.ok;
    });
    await step('branch', async () => (await git(['switch', '-c', branch])).ok);
    await step(
      'commit',
      async () =>
        (
          await git([
            'commit',
            '--allow-empty',
            '--message',
            `devfleet: verify the GitHub workflow from ${node}`,
          ])
        ).ok
    );
    await step('push', async () => {
      pushed = (await git(['push', '--set-upstream', 'origin', branch])).ok;
      return pushed;
    });
    await step('pull-request', async () => {
      const created = await gh([
        'pr',
        'create',
        '--repo',
        sandbox,
        '--head',
        branch,
        '--draft',
        '--title',
        `devfleet verify ${node}`,
        '--body',
        'Opened by devfleet fleet-github-verify; closed again by the same run.',
      ]);
      const url = created.stdout.trim().split('\n').pop() ?? '';
      if (created.ok && /^https:\/\/\S+\/pull\/\d+$/.test(url))
        pullRequest = url;
      return pullRequest !== null;
    });
    await step(
      'read-checks',
      async () =>
        (
          await gh([
            'pr',
            'view',
            pullRequest!,
            '--repo',
            sandbox,
            '--json',
            'statusCheckRollup',
          ])
        ).ok
    );
    await step(
      'comment',
      async () =>
        (
          await gh([
            'pr',
            'comment',
            pullRequest!,
            '--repo',
            sandbox,
            '--body',
            'devfleet fleet-github-verify: comment step.',
          ])
        ).ok
    );
  } finally {
    // Clean-up runs whatever failed, and is itself checked.
    if (pullRequest !== null) {
      const closed = await gh([
        'pr',
        'close',
        pullRequest,
        '--repo',
        sandbox,
        '--delete-branch',
      ]);
      if (!closed.ok) leftBehind.push(pullRequest, branch);
    } else if (pushed) {
      const deleted = await git(['push', 'origin', '--delete', branch]);
      if (!deleted.ok) leftBehind.push(branch);
    }
    if (!input.directory) await rm(directory, { recursive: true, force: true });
  }
  return result(branch, failed, leftBehind);
}

function result(
  branch: string,
  failed: WorkflowStep | undefined,
  leftBehind: string[]
): WorkflowResult {
  const check: Check =
    failed === undefined && leftBehind.length === 0
      ? {
          id: 'github:workflow',
          status: 'pass',
          summary:
            'Cloned the sandbox, pushed a branch, opened a draft pull request, read its checks and commented, then cleaned up.',
        }
      : {
          id: 'github:workflow',
          status: 'fail',
          summary: failed
            ? `GITHUB_WORKFLOW_FAILED: ${failed}`
            : `GITHUB_WORKFLOW_CLEANUP_FAILED: ${leftBehind.join(', ')}`,
          remedy: {
            action: failed
              ? remedyFor(failed)
              : 'Close the pull request and delete the branch named on the sandbox repository.',
          },
        };
  return { check, ...(failed ? { failed } : {}), branch, leftBehind };
}

function remedyFor(step: WorkflowStep): string {
  return {
    clone:
      'This node cannot clone the sandbox over HTTPS: check github:git-credential and that the fleet login can read github.sandbox.',
    branch:
      'git could not create a branch in a fresh clone; check git on this node.',
    commit:
      'git could not commit: set user.name and user.email for the fleet login on this node.',
    push: 'The token cannot push to the sandbox: check github:permissions (repo or contents: write).',
    'pull-request':
      'The token cannot open a pull request: it needs the pull requests permission on the sandbox.',
    'read-checks':
      'The token cannot read the checks of a pull request: it needs checks and statuses read access.',
    comment:
      'The token cannot comment on a pull request: it needs the pull requests (write) permission.',
  }[step];
}
