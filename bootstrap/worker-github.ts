/** GitHub sign-in of this node from the stored credential; never copies a
 * login directory. Runs from the timer (`personal-worker-github`) and from
 * every sync. One JSON line, never a token or raw output.
 */
import { hostname } from 'node:os';
import { fleet } from '../src/fleet-config';
import { secretsProvider } from '../src/secrets';
import { runCommand } from '../src/runner';
import { hostId } from '../src/topology';
import { githubCredential } from '../src/github/credential';
import { githubNode } from '../src/github/policy';
import { syncGithub, type GithubSyncResult } from '../src/github/sync';

/** The exit status of each outcome, so the unit's result names it too. */
export const EXIT_CODES: Record<GithubSyncResult['code'], number> = {
  GITHUB_OK: 0,
  GITHUB_TOKEN_MISSING: 10,
  GITHUB_TOKEN_REJECTED: 11,
  GITHUB_LOGIN_MISMATCH: 12,
  GITHUB_UNREACHABLE: 13,
  GITHUB_SIGN_IN_FAILED: 14,
};

export const GITHUB_JOB = 'dev-fleet-github';

if (import.meta.main) {
  const started = Date.now();
  // The manager is never a declared worker; `--node` names a worker whose
  // host name is not its id.
  const flag = process.argv.indexOf('--node');
  const id = flag > 0 ? process.argv[flag + 1] : hostId(hostname());
  const target = githubNode(fleet, id);
  const result: GithubSyncResult =
    target.login === null
      ? { code: 'GITHUB_LOGIN_MISMATCH', adopted: false }
      : await syncGithub({
          run: runCommand,
          token: githubCredential(
            fleet,
            target.node,
            secretsProvider(fleet.secrets)
          ),
          login: target.login,
          // A person's own login on the manager is measured, never replaced.
          apply: target.managed,
        });
  process.stdout.write(
    JSON.stringify({
      name: GITHUB_JOB,
      event: 'job_finished',
      role: target.role,
      code: result.code,
      adopted: result.adopted,
      durationMs: Date.now() - started,
    }) + '\n'
  );
  process.exitCode = EXIT_CODES[result.code];
}
