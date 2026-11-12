import type { Check, Runner } from '../types';
import type { GithubCode } from './sync';

const CODES: GithubCode[] = [
  'GITHUB_OK',
  'GITHUB_TOKEN_MISSING',
  'GITHUB_TOKEN_REJECTED',
  'GITHUB_LOGIN_MISMATCH',
  'GITHUB_UNREACHABLE',
  'GITHUB_SIGN_IN_FAILED',
];

const REMEDIES: Record<Exclude<GithubCode, 'GITHUB_OK'>, string> = {
  GITHUB_TOKEN_MISSING:
    'Store the fleet GitHub token in the secrets provider under github-token (github-token-<node> with github.credential "per-node"), then run fleet-sync again.',
  GITHUB_TOKEN_REJECTED:
    'GitHub refuses the stored token: it was revoked or has expired. Store a new one under github-token and run fleet-sync again.',
  GITHUB_LOGIN_MISMATCH:
    'The stored token belongs to another account than the fleet configuration declares (worker.githubLogin, or github.manager for the manager). Store the right token or correct the declaration.',
  GITHUB_UNREACHABLE:
    'GitHub did not answer from this node. Check its network and DNS; the node keeps the sign-in it has.',
  GITHUB_SIGN_IN_FAILED:
    'gh refused to store the validated token. Inspect gh on this node (gh auth status); nothing was copied from another machine.',
};

/** Runs this node's GitHub sign-in job once and reports what it came to. A
 * failure fails the sync: a node that cannot reach GitHub as the fleet login
 * is not ready for an agent.
 */
export async function convergeGithub(
  root: string,
  run: Runner,
  node?: string
): Promise<Check> {
  const result = await run(
    ['bun', 'bootstrap/worker-github.ts', ...(node ? ['--node', node] : [])],
    { cwd: root, timeoutMs: 240_000 }
  );
  let code: GithubCode | undefined;
  try {
    const line: unknown = JSON.parse(result.stdout.trim().split('\n').pop()!);
    const found = (line as { code?: unknown }).code;
    if (CODES.includes(found as GithubCode)) code = found as GithubCode;
  } catch {}
  if (code === 'GITHUB_OK')
    return {
      id: 'github:sync',
      status: 'pass',
      summary:
        'This node is signed in to GitHub as its declared login with the stored credential.',
    };
  return {
    id: 'github:sync',
    status: 'fail',
    summary: code ?? 'GITHUB_SYNC_UNREPORTED',
    remedy: {
      action: code
        ? REMEDIES[code]
        : 'The GitHub sign-in job reported no result. Run bun bootstrap/worker-github.ts on this node to see its result line.',
    },
  };
}
