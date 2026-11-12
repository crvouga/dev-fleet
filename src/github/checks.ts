import type { FleetDefinition } from '../definition';
import type { SecretsProvider } from '../secrets';
import type { Check, Runner } from '../types';
import { githubCredential } from './credential';
import { githubNode, githubPolicy, type GithubNode } from './policy';
import { activeToken, GITHUB_STEP_TIMEOUT_MS } from './sync';

export interface GithubCheckInput {
  definition: FleetDefinition;
  /** The node measured; the manager when it is not a declared worker. */
  node?: string;
  secret: SecretsProvider;
  now?: () => Date;
}

const DAY = 86_400_000;
const EXPIRY_WARN_DAYS = 14;
const EXPIRY_FAIL_DAYS = 3;
const RATE_WARN_FRACTION = 0.2;

/** GitHub sign-in on any node, manager or worker: what the token is, what it
 * can do and for how long. One request to GitHub answers the scopes, the
 * expiry and the rate limit together; nothing it prints is kept.
 */
export async function githubChecks(
  run: Runner,
  input: GithubCheckInput
): Promise<Check[]> {
  const target = githubNode(input.definition, input.node);
  const policy = githubPolicy(input.definition);
  const status = await run(['gh', 'auth', 'status', '--active'], {
    timeoutMs: 15_000,
  });
  const checks: Check[] = [
    {
      id: 'auth:github',
      status: status.ok ? 'pass' : 'fail',
      summary: status.ok
        ? 'github check succeeded in this process context.'
        : `github check failed (${status.reason}); no credential output retained.`,
      ...(status.ok
        ? {}
        : {
            remedy: {
              action: target.managed
                ? 'Put the fleet GitHub token in the secrets provider under github-token, then run fleet-sync: it signs this node in. No interactive login is needed.'
                : 'Authenticate on this node with gh auth login, then gh auth setup-git.',
            },
          }),
    },
  ];
  const user = await run(['gh', 'api', '--include', 'user'], {
    timeoutMs: GITHUB_STEP_TIMEOUT_MS,
  });
  const response = parseResponse(user.stdout);
  const login =
    user.ok && typeof response.body?.['login'] === 'string'
      ? response.body['login']
      : null;
  checks.push(principal(target, login));
  if (target.managed) checks.push(await tokenCurrent(run, target, input));
  if (login === null) return checks;
  const now = (input.now ?? (() => new Date()))();
  checks.push(
    await permissions(run, policy.scopes, policy.repositories, response),
    expiry(response.headers, now),
    rateLimit(response.headers),
    ...(await organizationAccess(run, policy.organizations, login)),
    await gitCredential(run)
  );
  return checks;
}

interface Response {
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** `gh api --include`: a status line, headers, a blank line, then the body. */
export function parseResponse(text: string): Response {
  const [head = '', ...rest] = text.split(/\r?\n\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const at = line.indexOf(':');
    if (at > 0)
      headers[line.slice(0, at).trim().toLowerCase()] = line
        .slice(at + 1)
        .trim();
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(rest.join('\n\n'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {}
  return { headers, body };
}

function principal(target: GithubNode, login: string | null): Check {
  if (target.login === null)
    return {
      id: 'github:principal',
      status: 'skip',
      required: false,
      summary:
        'The fleet declares no GitHub login (worker.githubLogin); the account is not compared.',
    };
  const ok = login === target.login;
  return {
    id: 'github:principal',
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `This ${target.role} is signed in to GitHub as the declared ${target.managed ? 'fleet' : 'personal'} login.`
      : login === null
        ? 'GITHUB_NOT_SIGNED_IN'
        : 'GITHUB_LOGIN_MISMATCH: this node is signed in to GitHub as an account the fleet configuration does not declare for it.',
    ...(ok
      ? {}
      : {
          remedy: {
            action: target.managed
              ? 'Run fleet-sync: it signs this node in with the token in the secrets provider (github-token). If the stored token belongs to another account, replace it or change worker.githubLogin.'
              : 'Sign in on this manager as the login named in github.manager of the fleet configuration (gh auth login), or change that declaration. dev-fleet never replaces a personal login.',
          },
        }),
  };
}

/** The node uses the token the store holds now: after a rotation, every node
 * passes before the old token is revoked.
 */
async function tokenCurrent(
  run: Runner,
  target: GithubNode,
  input: GithubCheckInput
): Promise<Check> {
  const stored = (
    (await githubCredential(input.definition, target.node, input.secret)()) ??
    ''
  ).trim();
  if (!stored)
    return {
      id: 'github:token-current',
      status: 'skip',
      required: false,
      summary:
        'The secrets provider holds no github-token for this node; there is no stored token to compare with.',
    };
  const ok = (await activeToken(run)) === stored;
  return {
    id: 'github:token-current',
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? 'This node signs GitHub requests with the token the store holds now.'
      : 'GITHUB_TOKEN_STALE: this node still uses a token the store no longer holds.',
    ...(ok
      ? {}
      : {
          remedy: {
            action:
              'Run fleet-sync, or wait for the next run of the GitHub sign-in job: either adopts the stored token while the old one still works. Revoke the old token only when every node passes this check.',
          },
        }),
  };
}

/** A scope a token has implies the scopes beneath it. */
const IMPLIED: Record<string, string[]> = {
  repo: [
    'repo:status',
    'repo_deployment',
    'public_repo',
    'repo:invite',
    'security_events',
  ],
  'write:packages': ['read:packages'],
  'admin:org': ['write:org', 'read:org', 'manage_runners:org'],
  'write:org': ['read:org'],
  'admin:repo_hook': ['write:repo_hook', 'read:repo_hook'],
  'write:repo_hook': ['read:repo_hook'],
  'admin:public_key': ['write:public_key', 'read:public_key'],
  'write:public_key': ['read:public_key'],
  user: ['read:user', 'user:email', 'user:follow'],
};

async function permissions(
  run: Runner,
  scopes: string[],
  repositories: string[],
  response: Response
): Promise<Check> {
  const base = { id: 'github:permissions' };
  if (!scopes.length && !repositories.length)
    return {
      ...base,
      status: 'skip',
      required: false,
      summary:
        'The fleet declares no GitHub scopes or repositories (github.scopes, github.repositories).',
    };
  const granted = response.headers['x-oauth-scopes'];
  const missing: string[] = [];
  if (scopes.length && granted !== undefined) {
    const held = new Set(
      granted
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
        .flatMap((scope) => [scope, ...(IMPLIED[scope] ?? [])])
    );
    missing.push(...scopes.filter((scope) => !held.has(scope)));
  }
  for (const repository of repositories) {
    const result = await run(
      ['gh', 'api', `repos/${repository}`, '--jq', '.permissions.push'],
      { timeoutMs: GITHUB_STEP_TIMEOUT_MS }
    );
    if (!result.ok || result.stdout.trim() !== 'true')
      missing.push(`push to ${repository}`);
  }
  if (missing.length)
    return {
      ...base,
      status: 'fail',
      summary: `GITHUB_PERMISSION_MISSING: ${missing.join(', ')}`,
      remedy: {
        action:
          'Issue a token with the permissions named, store it as github-token and run fleet-sync. A token without them fails agents mid-task with a 403.',
      },
    };
  // A fine-grained token reports no scopes: only the repositories are proof.
  if (scopes.length && granted === undefined)
    return {
      ...base,
      status: 'warn',
      summary:
        'GITHUB_SCOPES_NOT_OBSERVABLE: the token reports no scopes (a fine-grained token); the declared repositories were checked.',
    };
  return {
    ...base,
    status: 'pass',
    summary:
      'The token holds every declared scope and can push to every declared repository.',
  };
}

/** `2026-11-20 12:00:00 UTC` or `2026-11-20 12:00:00 -0800`. */
export function parseExpiry(value: string): Date | null {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(value);
  if (!match) return null;
  const zone =
    match[3] === 'UTC' ? 'Z' : `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`;
  const date = new Date(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function expiry(headers: Record<string, string>, now: Date): Check {
  const value = headers['github-authentication-token-expiration'];
  const base = { id: 'github:expiry' };
  if (value === undefined)
    return {
      ...base,
      status: 'pass',
      summary: 'GitHub reports no expiry date for this token.',
    };
  const date = parseExpiry(value);
  if (!date)
    return {
      ...base,
      status: 'warn',
      summary:
        'GitHub reported an expiry date in a form this check does not read.',
    };
  const days = (date.getTime() - now.getTime()) / DAY;
  const at = date.toISOString();
  const remedy = {
    action:
      'Issue a new token, store it as github-token and run fleet-sync before this one expires; every node adopts it while the old one still works.',
  };
  if (days <= EXPIRY_FAIL_DAYS)
    return {
      ...base,
      status: 'fail',
      summary: `GITHUB_TOKEN_EXPIRING: the token expires at ${at}.`,
      remedy,
    };
  if (days <= EXPIRY_WARN_DAYS)
    return {
      ...base,
      status: 'warn',
      summary: `GITHUB_TOKEN_EXPIRING_SOON: the token expires at ${at}.`,
      remedy,
    };
  return { ...base, status: 'pass', summary: `The token expires at ${at}.` };
}

function rateLimit(headers: Record<string, string>): Check {
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  const base = { id: 'github:rate-limit' };
  if (!(limit > 0) || !Number.isFinite(remaining))
    return {
      ...base,
      status: 'skip',
      required: false,
      summary: 'GitHub reported no rate limit for this request.',
    };
  const percent = Math.round((remaining / limit) * 100);
  const resetAt = Number.isFinite(reset)
    ? new Date(reset * 1000).toISOString()
    : 'an unknown time';
  if (remaining / limit < RATE_WARN_FRACTION)
    return {
      ...base,
      status: 'warn',
      summary: `GITHUB_RATE_LIMIT_LOW: ${remaining} of ${limit} requests (${percent} %) remain until ${resetAt}.`,
      remedy: {
        action:
          'Every node shares the rate limit of one login. Spread the load with per-node credentials (github.credential "per-node") or wait for the reset.',
      },
    };
  return {
    ...base,
    status: 'pass',
    summary: `${remaining} of ${limit} requests (${percent} %) remain until ${resetAt}.`,
  };
}

async function organizationAccess(
  run: Runner,
  organizations: string[],
  login: string
): Promise<Check[]> {
  if (!organizations.length) return [];
  const missing: string[] = [];
  const unauthorized: string[] = [];
  for (const organization of organizations) {
    const result = await run(
      ['gh', 'api', '--include', `user/memberships/orgs/${organization}`],
      { timeoutMs: GITHUB_STEP_TIMEOUT_MS }
    );
    const response = parseResponse(result.stdout);
    if (response.headers['x-github-sso']?.startsWith('required'))
      unauthorized.push(organization);
    else if (!result.ok || response.body?.['state'] !== 'active')
      missing.push(organization);
  }
  if (!missing.length && !unauthorized.length)
    return [
      {
        id: 'github:org-access',
        status: 'pass',
        summary: `${login} is an active member of every declared organisation, and single sign-on has authorised the token.`,
      },
    ];
  const reasons: string[] = [];
  if (unauthorized.length)
    reasons.push(
      `GITHUB_SSO_AUTHORIZATION_REQUIRED: ${unauthorized.join(', ')}`
    );
  if (missing.length)
    reasons.push(`GITHUB_ORG_MEMBERSHIP_MISSING: ${missing.join(', ')}`);
  return [
    {
      id: 'github:org-access',
      status: 'fail',
      summary: reasons.join('; '),
      remedy: {
        action:
          'Authorise the token for single sign-on in each organisation named (GitHub settings, Configure SSO), or add the fleet login to it. This needs a person who administers the organisation.',
      },
    },
  ];
}

/** git asks gh for the token at every use, so a replaced token needs no
 * change in git; no second copy of it is written.
 */
async function gitCredential(run: Runner): Promise<Check> {
  const helpers = await run(
    [
      'git',
      'config',
      '--global',
      '--get-all',
      'credential.https://github.com.helper',
    ],
    { timeoutMs: 5_000 }
  );
  const ok =
    helpers.ok &&
    helpers.stdout
      .split('\n')
      .some((line) => /(^|[/!\s])gh'? auth git-credential$/.test(line.trim()));
  return {
    id: 'github:git-credential',
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? 'git asks gh for the GitHub token at every use.'
      : 'GITHUB_GIT_CREDENTIAL_MISSING: git does not take its GitHub credential from gh.',
    ...(ok
      ? {}
      : {
          remedy: {
            action:
              'Declare the git block in fleet.json and run fleet-sync: ansible/github/git.yml sets gh as the credential helper. On a manager with a personal login, run gh auth setup-git.',
          },
        }),
  };
}
