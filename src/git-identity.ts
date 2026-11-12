import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runAnsible } from './platform/ansible';
import type { GitIdentity } from './definition';
import type { Check, Runner } from './types';

/** `ansible/github/git.yml` writes the declared identity and the GitHub
 * credential helper in the node's own Git configuration; the two checks
 * below measure them afterwards. The same on the manager and every worker.
 */
export async function convergeGitIdentity(
  root: string,
  git: GitIdentity | undefined,
  run: Runner,
  home: string = homedir()
): Promise<Check[]> {
  if (!git) return [];
  const result = await runAnsible(
    run,
    resolve(root, 'ansible/github/git.yml'),
    {
      cwd: resolve(root, 'ansible/github'),
      timeoutMs: 120_000,
      input: JSON.stringify({
        git_name: git.name,
        git_email: git.email,
        git_home: home,
      }),
    }
  );
  return [
    {
      id: 'git:configuration',
      status: result.ok ? 'pass' : 'fail',
      summary: result.ok
        ? 'The declared Git identity and the GitHub credential helper are written in ~/.config/git/config.'
        : 'GIT_CONFIGURATION_INCOMPLETE',
      ...(result.ok
        ? {}
        : {
            remedy: {
              action:
                'Inspect ~/.config/git/config and ~/.gitconfig on this node: a ~/.gitconfig that sets user.name, user.email or a GitHub credential helper wins over the fleet. Remove those lines and rerun fleet-sync.',
            },
          }),
    },
  ];
}

/** Git with no prompt: a missing credential fails instead of waiting. */
const QUIET = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

async function effective(run: Runner, key: string): Promise<string> {
  const result = await run(['git', 'config', '--global', '--get-all', key], {
    timeoutMs: 10_000,
  });
  return result.ok ? (result.stdout.trim().split('\n').pop() ?? '') : '';
}

/** Commits carry the declared author: the effective `user.name` and
 * `user.email` outside any repository are the fleet's.
 */
export async function gitIdentityCheck(
  git: GitIdentity | undefined,
  run: Runner
): Promise<Check> {
  const id = 'worker:git-identity';
  if (!git)
    return {
      id,
      status: 'warn',
      summary: 'GIT_IDENTITY_UNDECLARED',
      remedy: {
        action:
          'Declare git.name and git.email in fleet.json and rerun fleet-sync; until then commits on this node carry whatever author it happens to have.',
      },
    };
  const name = await effective(run, 'user.name');
  const email = await effective(run, 'user.email');
  if (name === git.name && email === git.email)
    return {
      id,
      status: 'pass',
      summary: `Commits on this node are authored as ${git.name} <${git.email}>.`,
    };
  return {
    id,
    status: 'fail',
    summary: !name || !email ? 'GIT_IDENTITY_MISSING' : 'GIT_IDENTITY_MISMATCH',
    remedy: {
      action:
        'Rerun fleet-sync: it writes the identity in ~/.config/git/config. A ~/.gitconfig that sets another user.name or user.email wins over it; remove those lines.',
    },
  };
}

/** A push is authorized through git itself, never through gh: Git's
 * credential helper must answer for github.com, and the declared repository
 * must answer an authenticated listing. The credential is read and dropped;
 * it is never kept, printed or reported.
 */
export async function gitPushAuthCheck(
  git: GitIdentity | undefined,
  run: Runner
): Promise<Check> {
  const id = 'worker:git-push-auth';
  const fill = await run(['git', 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    env: QUIET,
    timeoutMs: 20_000,
  });
  if (!fill.ok || !/^password=./m.test(fill.stdout))
    return {
      id,
      status: 'fail',
      summary: 'GIT_CREDENTIAL_HELPER_MISSING',
      remedy: {
        action:
          'Git has no credential for github.com, so an agent cannot push over HTTPS. Rerun fleet-sync, which declares gh as the credential helper; if gh is signed out, the worker signs in again from its own Vault session (auth:github).',
      },
    };
  if (git?.verifyRepository) {
    const listed = await run(
      ['git', 'ls-remote', '--heads', git.verifyRepository],
      { env: QUIET, timeoutMs: 30_000 }
    );
    if (!listed.ok)
      return {
        id,
        status: 'fail',
        summary:
          listed.reason === 'timeout'
            ? 'GIT_REMOTE_UNREACHABLE'
            : 'GIT_REMOTE_REFUSED',
        remedy: {
          action:
            "The declared repository (git.verifyRepository) did not answer git with this node's credentials. Check that the fleet's GitHub account can push to it and that github.com is reachable.",
        },
      };
  }
  return {
    id,
    status: 'pass',
    summary: git?.verifyRepository
      ? "Git's credential helper answers for github.com and the declared repository answers through git."
      : "Git's credential helper answers for github.com; declare git.verifyRepository to prove a repository too.",
  };
}

export async function gitChecks(
  git: GitIdentity | undefined,
  run: Runner
): Promise<Check[]> {
  return [await gitIdentityCheck(git, run), await gitPushAuthCheck(git, run)];
}
