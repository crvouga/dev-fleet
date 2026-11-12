import { record } from '../config';
import { FleetUsageError } from '../errors';
import type { FleetDefinition } from '../definition';

/** How the fleet signs in to GitHub, from the optional `github` block of its
 * fleet configuration. The fleet login itself is `worker.githubLogin`.
 */
export interface GithubPolicy {
  /** `fleet`: the manager signs in as the fleet login, like every worker.
   * `{ login }`: the manager keeps a person's own login, which is checked and
   * never replaced.
   */
  manager: 'fleet' | { login: string };
  /** `shared`: one token for every node (`github-token`). `per-node`: each
   * node has its own (`github-token-<node>`), so one can be revoked alone.
   */
  credential: 'shared' | 'per-node';
  /** Scopes the token must carry, such as `repo` and `workflow`. */
  scopes: string[];
  /** `owner/name` of repositories every node must be able to push to. */
  repositories: string[];
  /** Organisations whose single sign-on must have authorised the token. */
  organizations: string[];
  /** `owner/name` of a repository `fleet-github-verify` may branch, push to
   * and open pull requests on, then clean up.
   */
  sandbox?: string;
}

export const DEFAULT_GITHUB: GithubPolicy = {
  manager: 'fleet',
  credential: 'shared',
  scopes: [],
  repositories: [],
  organizations: [],
};

const LOGIN = /^[a-zA-Z0-9-]{1,39}$/;
const REPOSITORY = /^[a-zA-Z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SCOPE = /^[a-z:_]{1,40}$/;
const FIELDS = [
  'manager',
  'credential',
  'scopes',
  'repositories',
  'organizations',
  'sandbox',
];

function fail(): never {
  throw new FleetUsageError(
    'Invalid github block in fleet.json. "manager" is "fleet" or {"login": ...}, "credential" is "shared" or "per-node", "scopes", "repositories" (owner/name) and "organizations" are lists, "sandbox" is owner/name.'
  );
}

function list(value: unknown, pattern: RegExp): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    new Set(value).size !== value.length ||
    !value.every((item) => typeof item === 'string' && pattern.test(item))
  )
    return fail();
  return value as string[];
}

function managerLogin(value: unknown): GithubPolicy['manager'] {
  if (value === undefined || value === 'fleet') return 'fleet';
  if (
    record(value) &&
    Object.keys(value).length === 1 &&
    typeof value['login'] === 'string' &&
    LOGIN.test(value['login'])
  )
    return { login: value['login'] };
  return fail();
}

function repository(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && REPOSITORY.test(value) ? value : fail();
}

export function parseGithubPolicy(value: unknown): GithubPolicy {
  if (
    !record(value) ||
    !Object.keys(value).every((key) => FIELDS.includes(key))
  )
    return fail();
  const credential = value['credential'] ?? 'shared';
  if (credential !== 'shared' && credential !== 'per-node') return fail();
  const sandbox = repository(value['sandbox']);
  return {
    manager: managerLogin(value['manager']),
    credential,
    scopes: list(value['scopes'], SCOPE),
    repositories: list(value['repositories'], REPOSITORY),
    organizations: list(value['organizations'], LOGIN),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

export type GithubRole = 'manager' | 'worker';

/** What GitHub sign-in on one node is held to. */
export interface GithubNode {
  role: GithubRole;
  /** The node's id: it names a per-node credential. */
  node: string;
  /** The login the node must be signed in as; null when the fleet declares
   * none (no worker policy).
   */
  login: string | null;
  /** Whether dev-fleet signs this node in from the stored credential, or only
   * checks a person's own login.
   */
  managed: boolean;
}

export function githubPolicy(definition: FleetDefinition): GithubPolicy {
  return definition.github ?? DEFAULT_GITHUB;
}

/** The manager when `node` is not a declared worker. */
export function githubNode(
  definition: FleetDefinition,
  node?: string
): GithubNode {
  const policy = githubPolicy(definition);
  const fleetLogin = definition.worker?.githubLogin ?? null;
  if (node !== undefined && definition.workers.some((w) => w.id === node))
    return { role: 'worker', node, login: fleetLogin, managed: true };
  const personal = policy.manager !== 'fleet';
  return {
    role: 'manager',
    node: definition.manager.id,
    login: policy.manager === 'fleet' ? fleetLogin : policy.manager.login,
    managed: !personal,
  };
}
