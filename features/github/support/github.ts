import type { CommandOptions, CommandResult, Runner } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';

/** One pull request on the stand-in GitHub. */
interface PullRequest {
  branch: string;
  open: boolean;
}

/** A request a node made to GitHub, and whether it was answered. */
export interface Request {
  node: string;
  ok: boolean;
}

/** Stands in for GitHub and for gh and git on every node: which login each
 * token belongs to, which tokens are revoked, what each node's gh holds and
 * what each node's git asks for its credential. Nothing real is contacted.
 */
export class StandInGithub {
  /** token → login */
  readonly owners = new Map<string, string>();
  readonly revoked = new Set<string>();
  /** node → the token its gh holds */
  readonly held = new Map<string, string>();
  /** node → the lines of git's GitHub credential helper */
  readonly helpers = new Map<string, string[]>();
  readonly requests: Request[] = [];
  reachable = true;
  /** Headers of every answer to `gh api --include user`. */
  headers: Record<string, string> = {};
  /** repository → whether the token may push */
  readonly push = new Map<string, boolean>();
  /** organisation → membership as GitHub reports it */
  readonly organizations = new Map<string, 'active' | 'sso' | 'none'>();
  copilotInstalled = true;
  // The sandbox repository.
  readonly branches = new Set<string>();
  readonly pulls = new Map<string, PullRequest>();
  /** A step the stand-in refuses: `push`, `pull-request`, `comment`, … */
  refuse: string | undefined;
  identityConfigured = true;

  private answer(node: string, token: string | undefined): string | null {
    const login =
      token !== undefined && !this.revoked.has(token)
        ? (this.owners.get(token) ?? null)
        : null;
    this.requests.push({ node, ok: login !== null });
    return login;
  }

  /** gh, git and copilot on `node`; anything else goes to `otherwise`. */
  runner(node: string, otherwise: Runner): Runner {
    return async (command, options) =>
      this.handle(node, command, options) ?? otherwise(command, options);
  }

  private handle(
    node: string,
    command: string[],
    options: CommandOptions = {}
  ): CommandResult | null {
    const line = command.join(' ');
    const env = options.env ?? {};
    const token = env['GH_TOKEN'] ?? this.held.get(node);
    const unreachable = failed('dial tcp: lookup api.github.com: no such host');
    if (line === 'gh api user --jq .login') {
      if (!this.reachable) return unreachable;
      const login = this.answer(node, token);
      return login === null
        ? failed('HTTP 401: Bad credentials (https://api.github.com/user)')
        : succeeded(`${login}\n`);
    }
    if (line === 'gh auth token --hostname github.com') {
      const held = this.held.get(node);
      return held ? succeeded(`${held}\n`) : failed('no oauth token');
    }
    if (line === 'gh auth login --hostname github.com --with-token') {
      this.held.set(node, (options.input ?? '').trim());
      return succeeded();
    }
    if (line === 'gh auth status --active') {
      if (!this.reachable) return unreachable;
      return this.answer(node, token) === null ? failed() : succeeded();
    }
    if (line === 'gh api --include user') {
      if (!this.reachable) return unreachable;
      const login = this.answer(node, token);
      if (login === null) return failed('HTTP 401: Bad credentials');
      const headers = Object.entries(this.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
      return succeeded(
        `HTTP/2.0 200 OK\n${headers}\n\n${JSON.stringify({ login })}`
      );
    }
    const repository = /^gh api repos\/(\S+) --jq \.permissions\.push$/.exec(
      line
    );
    if (repository)
      return succeeded(`${this.push.get(repository[1]!) ?? false}\n`);
    const organization =
      /^gh api --include user\/memberships\/orgs\/(\S+)$/.exec(line);
    if (organization) {
      const state = this.organizations.get(organization[1]!) ?? 'none';
      if (state === 'sso')
        return {
          ...failed('HTTP 403'),
          stdout:
            'HTTP/2.0 403 Forbidden\nX-Github-Sso: required; url=https://github.com/orgs/x/sso\n\n{}',
        };
      if (state === 'none')
        return {
          ...failed('HTTP 404'),
          stdout: 'HTTP/2.0 404 Not Found\n\n{}',
        };
      return succeeded('HTTP/2.0 200 OK\n\n{"state":"active"}');
    }
    if (
      line ===
      'git config --global --get-all credential.https://github.com.helper'
    ) {
      const lines = this.helpers.get(node);
      return lines ? succeeded(lines.join('\n') + '\n') : failed();
    }
    if (line === 'copilot --version')
      return this.copilotInstalled ? succeeded('1.0.105\n') : failed();
    return this.sandbox(node, command);
  }

  /** git and gh against the sandbox repository. */
  private sandbox(node: string, command: string[]): CommandResult | null {
    const usable = () =>
      this.reachable && this.answer(node, this.held.get(node)) !== null;
    const refused = (step: string) => this.refuse === step || !usable();
    if (command[0] === 'git' && command[1] === 'clone')
      return refused('clone') ? failed('clone refused') : succeeded();
    if (command[0] === 'git' && command[1] === '-C') {
      const args = command.slice(3);
      if (args[0] === 'switch') return succeeded();
      if (args[0] === 'commit')
        return this.identityConfigured
          ? succeeded()
          : failed('Please tell me who you are');
      if (args[0] === 'push' && args[2] === '--delete') {
        if (refused('delete')) return failed();
        this.branches.delete(args[3]!);
        return succeeded();
      }
      if (args[0] === 'push') {
        if (refused('push')) return failed('403');
        this.branches.add(args.at(-1)!);
        return succeeded();
      }
    }
    if (command[0] === 'gh' && command[1] === 'pr') {
      const verb = command[2];
      if (verb === 'create') {
        if (refused('pull-request')) return failed('403');
        const branch = command[command.indexOf('--head') + 1]!;
        const url = `https://github.com/example-org/sandbox/pull/${this.pulls.size + 1}`;
        this.pulls.set(url, { branch, open: true });
        return succeeded(`${url}\n`);
      }
      if (verb === 'view')
        return refused('read-checks')
          ? failed('403')
          : succeeded('{"statusCheckRollup":[]}');
      if (verb === 'comment')
        return refused('comment') ? failed('403') : succeeded();
      if (verb === 'close') {
        if (refused('close')) return failed('403');
        const pull = this.pulls.get(command[3]!);
        if (pull) {
          pull.open = false;
          if (command.includes('--delete-branch'))
            this.branches.delete(pull.branch);
        }
        return succeeded();
      }
    }
    return null;
  }
}
