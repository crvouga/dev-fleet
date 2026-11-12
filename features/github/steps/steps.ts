import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { authCheck } from '../../../src/auth-checks';
import { fleet } from '../../../src/fleet-config';
import { githubChecks } from '../../../src/github/checks';
import { convergeGithub } from '../../../src/github/converge';
import { copilotCheck } from '../../../src/github/copilot';
import { githubCredential } from '../../../src/github/credential';
import {
  DEFAULT_GITHUB,
  githubNode,
  parseGithubPolicy,
} from '../../../src/github/policy';
import {
  GITHUB_STEP_TIMEOUT_MS,
  syncGithub,
  type GithubSyncResult,
} from '../../../src/github/sync';
import {
  verifyGithubWorkflow,
  type WorkflowResult,
} from '../../../src/github/workflow';
import { githubVerify } from '../../../src/cli/github-verify';
import { envName, vaultLocation, secretVariant } from '../../../src/secrets';
import { workerAccessChecks } from '../../../src/worker-access-checks';
import type { Check } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { github, type GithubWorld, type Provider } from './world';

const { Given, When, Then } = github;
const root = join(import.meta.dir, '../../..');
const MANAGER = fleet.manager.id;

// ── The fleet ────────────────────────────────────────────────────────────

Given('the fleet login is {string}', (world, login: string) => {
  // The example configuration declares it; the scenario says which it is.
  expect(world.definition.worker?.githubLogin).toBe(login);
});

Given("the fleet's github block is:", (world, block: string) => {
  world.definition = {
    ...world.definition,
    github: parseGithubPolicy(JSON.parse(block)),
  };
});

Given(
  'the fleet keeps its secrets with the {string} provider',
  (world, provider: Provider) => {
    world.provider = provider;
  }
);

Given(
  'the store holds {string} as {string}',
  (world, token: string, name: string) => {
    if (token !== 'nothing') world.stored.set(name, token);
  }
);

Given('it is {string}', (world, now: string) => {
  world.now = new Date(now);
});

// ── GitHub ───────────────────────────────────────────────────────────────

Given(
  'GitHub knows the token {string} as {string}',
  (world, token: string, login: string) => {
    world.github.owners.set(token, login);
  }
);

Given('GitHub has revoked the token {string}', (world, token: string) => {
  world.github.revoked.add(token);
});

Given('GitHub can be reached', () => {});

Given('GitHub cannot be reached', (world) => {
  world.github.reachable = false;
});

Given(
  '{string} is signed in with {string}',
  (world, node: string, token: string) => {
    world.github.held.set(node, token);
  }
);

Given('{string} is not signed in to GitHub', (world, node: string) => {
  world.github.held.delete(node);
});

Given(
  'GitHub answers with the header {string} set to {string}',
  (world, name: string, value: string) => {
    world.github.headers[name] = value;
  }
);

Given('the token can push to {string}', (world, repository: string) => {
  world.github.push.set(repository, true);
});

Given(
  /^in "([^"]+)" the fleet login is (an active member|awaiting single sign-on|not a member)$/,
  (world, organization: string, membership: string) => {
    world.github.organizations.set(
      organization,
      (
        {
          'an active member': 'active',
          'awaiting single sign-on': 'sso',
          'not a member': 'none',
        } as const
      )[membership as 'not a member']
    );
  }
);

Given(
  'git on {string} has these GitHub credential helpers:',
  (world, node: string, table: DataTable) => {
    world.github.helpers.set(node, table.list());
  }
);

Given('git on {string} has no identity to commit with', (world) => {
  world.github.identityConfigured = false;
});

Given('Copilot CLI is not installed', (world) => {
  world.github.copilotInstalled = false;
});

Given('the sandbox refuses the step {string}', (world, step: string) => {
  world.github.refuse = step;
});

// ── Whens ────────────────────────────────────────────────────────────────

async function signIn(world: GithubWorld, node: string): Promise<void> {
  const target = githubNode(world.definition, node);
  const result: GithubSyncResult = await syncGithub({
    run: world.runner(node),
    token: githubCredential(
      world.definition,
      target.node,
      await world.secret(node)
    ),
    login: target.login!,
    apply: target.managed,
  });
  world.results.set(node, result);
}

When('the GitHub sign-in job runs on {string}', async (world, node: string) => {
  await signIn(world, node);
});

When('the GitHub sign-in job runs on the manager', async (world) => {
  await signIn(world, MANAGER);
});

When(
  'the GitHub sign-in job runs on each of these nodes, in order:',
  async (world, table: DataTable) => {
    for (const node of table.list()) await signIn(world, node);
  }
);

async function checkGithub(world: GithubWorld, node?: string): Promise<void> {
  world.checks = await githubChecks(world.runner(node ?? MANAGER), {
    definition: world.definition,
    ...(node === undefined ? {} : { node }),
    secret: await world.secret(node ?? MANAGER),
    now: () => world.now,
  });
}

When('the GitHub checks run on {string}', async (world, node: string) => {
  await checkGithub(world, node);
});

When('the GitHub checks run on the manager', async (world) => {
  await checkGithub(world);
});

When(
  'fleet-status checks the {string} capability on the manager',
  async (world, capability: 'github') => {
    world.checks = await authCheck(capability, world.runner(MANAGER), root);
  }
);

When('the access of {string} is checked', async (world, node: string) => {
  world.checks = await workerAccessChecks(world.runner(node), node);
});

When(
  'the GitHub sign-in of {string} is converged',
  async (world, node: string) => {
    world.checks = [await convergeGithub(root, world.runner(node), node)];
  }
);

When(
  'the sign-in of Copilot CLI is checked on {string}',
  async (world, node: string) => {
    world.checks = [await copilotCheck(world.runner(node))];
  }
);

When(
  'the GitHub workflow is verified from {string}',
  async (world, node: string) => {
    const sandbox = world.definition.github?.sandbox;
    if (!sandbox) {
      // The command itself reads the configuration in use.
      await world.attempt(async () => {
        await githubVerify(world.runner(node), node);
      });
      return;
    }
    const result = await verifyGithubWorkflow({
      run: world.runner(node),
      sandbox,
      node,
    });
    world.workflows.push(result);
    world.checks = [result.check];
  }
);

When(
  'the GitHub workflow is verified {int} times from {string}',
  async (world, times: number, node: string) => {
    for (let run = 0; run < times; run++)
      world.workflows.push(
        await verifyGithubWorkflow({
          run: world.runner(node),
          sandbox: world.definition.github!.sandbox!,
          node,
        })
      );
  }
);

// ── Thens ────────────────────────────────────────────────────────────────

const result = (world: GithubWorld, node: string) =>
  world.results.get(node) as GithubSyncResult | undefined;

Then(
  'the result on {string} is {string}',
  (world, node: string, code: string) => {
    expect<string | undefined>(result(world, node)?.code).toBe(code);
  }
);

Then(
  '{string} holds the token {string}',
  (world, node: string, token: string) => {
    expect(world.github.held.get(node)).toBe(token);
  }
);

Then('{string} is not signed in', (world, node: string) => {
  expect(world.github.held.get(node)).toBeUndefined();
});

Then(
  'each of these nodes holds the token {string}:',
  (world, token: string, table: DataTable) => {
    for (const node of table.list())
      expect(world.github.held.get(node)).toBe(token);
  }
);

Then(
  'each of these nodes reports that it adopted the stored token:',
  (world, table: DataTable) => {
    for (const node of table.list())
      expect(result(world, node)).toEqual({ code: 'GITHUB_OK', adopted: true });
  }
);

Then('no request to GitHub failed', (world) => {
  expect(world.github.requests.length).toBeGreaterThan(0);
  expect(world.github.requests.filter((request) => !request.ok)).toEqual([]);
});

Then(
  'once {string} is revoked, GitHub still answers each of these nodes:',
  async (world, token: string, table: DataTable) => {
    world.github.revoked.add(token);
    for (const node of table.list()) {
      const answer = await world.runner(node)([
        'gh',
        'api',
        'user',
        '--jq',
        '.login',
      ]);
      expect(answer.ok).toBe(true);
    }
  }
);

Then('no command line contains {string}', (world, text: string) => {
  expect(world.lines.length).toBeGreaterThan(0);
  for (const line of world.lines) expect(line).not.toContain(text);
});

const found = (world: GithubWorld, id: string): Check => {
  if (world.failure !== undefined) throw world.failure;
  const check = world.checks.find((entry) => entry.id === id);
  expect(check).toBeDefined();
  return check!;
};

Then(
  /^the check "([^"]+)" (passes|fails|warns|is skipped)$/,
  (world, id: string, verdict: string) => {
    expect(found(world, id).status).toBe(
      (
        {
          passes: 'pass',
          fails: 'fail',
          warns: 'warn',
          'is skipped': 'skip',
        } as const
      )[verdict as 'passes']
    );
  }
);

Then('the check {string} says {string}', (world, id: string, text: string) => {
  expect(found(world, id).summary).toContain(text);
});

Then(
  'the remedy of the check {string} mentions {string}',
  (world, id: string, text: string) => {
    expect(found(world, id).remedy?.action).toContain(text);
  }
);

Then('no check {string} is reported', (world, id: string) => {
  expect(world.checks.map((check) => check.id)).not.toContain(id);
});

Then('these checks are reported, in this order:', (world, table: DataTable) => {
  expect(world.checks.map((check) => check.id)).toEqual(table.list());
});

Then('nothing reported contains {string}', (world, text: string) => {
  expect(JSON.stringify(world.checks)).not.toContain(text);
  expect(JSON.stringify(world.workflows)).not.toContain(text);
});

Then('the sandbox has no branch and no open pull request left', (world) => {
  expect(world.workflows.length).toBeGreaterThan(0);
  expect([...world.github.branches]).toEqual([]);
  expect([...world.github.pulls.values()].filter((pull) => pull.open)).toEqual(
    []
  );
});

Then('every run passed, each on a branch of its own', (world) => {
  const runs: WorkflowResult[] = world.workflows;
  expect(runs.every((run) => run.check.status === 'pass')).toBe(true);
  expect(new Set(runs.map((run) => run.branch)).size).toBe(runs.length);
});

Then('it is refused, saying {string}', (world, text: string) => {
  expect(String(world.failure)).toContain(text);
});

// ── The units and the playbooks ──────────────────────────────────────────

const read = (path: string): string => readFileSync(join(root, path), 'utf8');
type Task = Record<string, unknown> & { vars?: Record<string, number> };

When('the GitHub sign-in unit of a worker is read', (world) => {
  world.tasks = parse(read('ansible/ubuntu/tasks/github.yml')) as Task[];
});

const unit = (
  world: GithubWorld
): { content: string; vars: Record<string, number> } => {
  const task = world.tasks.find((entry) =>
    String(
      (entry['ansible.builtin.copy'] as { dest?: string } | undefined)?.dest
    ).endsWith('personal-worker-github.service')
  )!;
  return {
    content: (task['ansible.builtin.copy'] as { content: string }).content,
    vars: task.vars ?? {},
  };
};

Then(
  'it allows each of {int} steps its full timeout, and the runtime its start',
  (world, steps: number) => {
    const { content, vars } = unit(world);
    expect(vars['github_job_steps']).toBe(steps);
    expect(vars['github_step_timeout_seconds']! * 1000).toBe(
      GITHUB_STEP_TIMEOUT_MS
    );
    expect(content).toContain(
      'TimeoutStartSec={{ github_step_timeout_seconds * github_job_steps + github_job_start_seconds }}'
    );
  }
);

Then(
  'it runs {string} every {int} minutes',
  (world, script: string, minutes: number) => {
    expect(unit(world).content).toContain(`bun ${script}`);
    expect(read('ansible/ubuntu/tasks/github.yml')).toContain(
      `OnUnitActiveSec=${minutes}min`
    );
  }
);

Then('the Vault renewal unit does not run it', () => {
  expect(read('ansible/ubuntu/tasks/credentials.yml')).not.toContain(
    'worker-github'
  );
  expect(read('bootstrap/worker-auth.ts')).not.toMatch(
    /from '\.\/worker-github'/
  );
});

When('the GitHub tasks of the playbooks are read', (world) => {
  world.tasks = parse(read('ansible/ubuntu/tasks/github.yml')) as Task[];
});

Then(
  "only {string} sets git's GitHub credential helper",
  async (_world, owner: string) => {
    const setters: string[] = [];
    for await (const path of new Bun.Glob('ansible/**/*.yml').scan(root))
      if (
        read(path).includes('credential "https://github.com"') ||
        read(path).includes('credential.https://github.com.helper')
      )
        setters.push(path);
    expect(setters).toEqual([owner]);
  }
);

Then('it clears every earlier helper before naming gh', () => {
  expect(read('ansible/github/git.yml')).toMatch(
    /\[credential "https:\/\/github\.com"\]\n\s*helper =\n\s*helper = \{\{ git_credential_helper \}\}/
  );
});

Then(
  'the GitHub sign-in tasks write no file but its job and timer',
  (world) => {
    const written = world.tasks
      .map(
        (task) => task['ansible.builtin.copy'] as { dest: string } | undefined
      )
      .filter(Boolean)
      .map((copy) => copy!.dest.split('/').at(-1));
    expect(written).toEqual([
      'personal-worker-github.service',
      'personal-worker-github.timer',
    ]);
    for (const task of world.tasks)
      expect(task['ansible.builtin.template']).toBeUndefined();
  }
);

// ── The configuration ────────────────────────────────────────────────────

When('the github block is absent', (world) => {
  world.policy = DEFAULT_GITHUB;
});

When(/^the github block (.+) is read$/, (world, block: string) => {
  try {
    world.policy = parseGithubPolicy(JSON.parse(block));
  } catch (error) {
    world.failure = error;
  }
});

Then('the manager signs in as {string}', (world, manager: string) => {
  expect<unknown>(world.policy?.manager).toBe(manager);
});

Then('the credential is {string}', (world, credential: string) => {
  expect<string | undefined>(world.policy?.credential).toBe(credential);
});

Then('the configuration is refused, saying {string}', (world, text: string) => {
  expect(String(world.failure)).toContain(text);
});

Then(
  'a Vault fleet reads {string} from {string} field {string}',
  (_world, name: 'github-token', path: string, field: string) => {
    if (fleet.secrets.provider !== 'vault')
      throw new Error('not a Vault fleet');
    expect(vaultLocation(fleet.secrets, name)).toEqual({ path, field });
  }
);

Then(
  'with the {string} provider the token of {string} is kept as {string}',
  (_world, provider: Provider, node: string, where: string) => {
    if (provider === 'env') expect(envName('github-token', node)).toBe(where);
    else if (provider === 'vault') {
      if (fleet.secrets.provider !== 'vault')
        throw new Error('not a Vault fleet');
      const location = vaultLocation(fleet.secrets, 'github-token', node);
      expect(`${location?.path} ${location?.field}`).toBe(where);
    } else expect(secretVariant('github-token', node)).toBe(where);
  }
);
