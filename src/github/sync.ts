import type { CommandResult, Runner } from '../types';

/** What GitHub sign-in on a node came to. Each failure names the system to
 * fix: the store (`MISSING`), GitHub's verdict on the stored token
 * (`REJECTED`), the fleet configuration or the store (`MISMATCH`), the network
 * (`UNREACHABLE`).
 */
export type GithubCode =
  | 'GITHUB_OK'
  | 'GITHUB_TOKEN_MISSING'
  | 'GITHUB_TOKEN_REJECTED'
  | 'GITHUB_LOGIN_MISMATCH'
  | 'GITHUB_UNREACHABLE'
  | 'GITHUB_SIGN_IN_FAILED';

export interface GithubSyncResult {
  code: GithubCode;
  /** The stored token replaced the one the node held. */
  adopted: boolean;
}

/** Each GitHub request and the secret read is bounded by this; the unit that
 * runs a sync allows every step its full time (ansible/ubuntu/tasks/github.yml).
 */
export const GITHUB_STEP_TIMEOUT_MS = 30_000;

export interface GithubSyncInput {
  run: Runner;
  /** The stored credential of this node, through the fleet's secrets provider. */
  token: () => Promise<string | null>;
  /** The login the node must be signed in as. */
  login: string;
  /** False: measure only, change nothing (a check, or a person's own login). */
  apply: boolean;
}

const TOKEN = /^[\x21-\x7e]{16,4096}$/;
/** gh prints GitHub's status line on a refused request. */
const REFUSED = /HTTP 401|Bad credentials/i;

/** gh with no token in its environment: it uses only the login it stores. */
const stored = { GH_TOKEN: undefined, GITHUB_TOKEN: undefined };

async function whoami(run: Runner, token?: string): Promise<CommandResult> {
  return run(['gh', 'api', 'user', '--jq', '.login'], {
    timeoutMs: GITHUB_STEP_TIMEOUT_MS,
    env: token ? { GH_TOKEN: token, GITHUB_TOKEN: undefined } : stored,
  });
}

/** The token gh signs requests with on this node, held in memory only. */
export async function activeToken(
  run: Runner,
  timeoutMs = GITHUB_STEP_TIMEOUT_MS
): Promise<string | null> {
  const result = await run(
    ['gh', 'auth', 'token', '--hostname', 'github.com'],
    { timeoutMs, env: stored }
  );
  const token = result.stdout.trim();
  return result.ok && TOKEN.test(token) ? token : null;
}

function refused(result: CommandResult): GithubCode {
  return REFUSED.test(result.stderr) || REFUSED.test(result.stdout)
    ? 'GITHUB_TOKEN_REJECTED'
    : 'GITHUB_UNREACHABLE';
}

/** Brings this node's GitHub sign-in to the stored credential, or with
 * `apply: false` says what doing so would find. A token that differs from the
 * one gh holds is adopted while the old one still works, so a rotation never
 * waits for a revocation to break every node at once. A token is never in
 * argv, a log or a result: gh receives it on standard input.
 */
export async function syncGithub(
  input: GithubSyncInput
): Promise<GithubSyncResult> {
  const { run, login, apply } = input;
  const current = await whoami(run);
  const signedIn = current.ok && current.stdout.trim() === login;
  const token = ((await input.token()) ?? '').trim();
  if (!TOKEN.test(token))
    return {
      code: signedIn ? 'GITHUB_OK' : 'GITHUB_TOKEN_MISSING',
      adopted: false,
    };
  if (signedIn && (await activeToken(run)) === token)
    return { code: 'GITHUB_OK', adopted: false };
  const owner = await whoami(run, token);
  if (!owner.ok) {
    // A stored token GitHub refuses is not adopted; the node keeps the one
    // that still works, and the failure names the store.
    return { code: refused(owner), adopted: false };
  }
  if (owner.stdout.trim() !== login)
    return { code: 'GITHUB_LOGIN_MISMATCH', adopted: false };
  // A measurement says what a sync would do: adopt the stored token.
  if (!apply) return { code: 'GITHUB_OK', adopted: false };
  const signIn = await run(
    ['gh', 'auth', 'login', '--hostname', 'github.com', '--with-token'],
    { input: token + '\n', env: stored, timeoutMs: GITHUB_STEP_TIMEOUT_MS }
  );
  if (!signIn.ok) return { code: 'GITHUB_SIGN_IN_FAILED', adopted: false };
  return { code: 'GITHUB_OK', adopted: true };
}

/** Why a node is not signed in, for a check: measures, never signs in. When the
 * node is signed in as the declared login nothing else is read.
 */
export async function githubSignInState(
  input: Omit<GithubSyncInput, 'apply'>
): Promise<GithubCode> {
  const current = await whoami(input.run);
  if (current.ok && current.stdout.trim() === input.login) return 'GITHUB_OK';
  const token = ((await input.token()) ?? '').trim();
  if (!TOKEN.test(token)) return 'GITHUB_TOKEN_MISSING';
  const owner = await whoami(input.run, token);
  if (!owner.ok) return refused(owner);
  if (owner.stdout.trim() !== input.login) return 'GITHUB_LOGIN_MISMATCH';
  // The stored token is good; the node has yet to adopt it.
  return 'GITHUB_SIGN_IN_FAILED';
}
