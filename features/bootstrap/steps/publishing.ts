import { expect } from 'bun:test';
import {
  bootstrap,
  measure,
  npmIsRecent,
  plan,
  seedTag,
  type Deps,
  type Exec,
  type Result,
  type Target,
} from '../../../bootstrap/npm';
import {
  bumpFor,
  bumpVersion,
  decide,
  newestPublished,
  latestTag,
  type Bump,
  type Decision,
  type Git,
} from '../../../bootstrap/release-version';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

export const publishing = steps<BootstrapWorld>();
const { Given, When, Then } = publishing;

/** Every `"quoted"` value of a list written in a step. */
const quoted = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);

// ── The one-time npm setup ───────────────────────────────────────────────

/** What the stand-in for publishing the seed version leaves in the list of
 * what ran: it is a checkout and an `npm publish`, never run here.
 */
const SEED = 'publish the seed version';

const ok = (stdout = ''): Result => ({ ok: true, stdout, stderr: '' });
const no = (stderr = ''): Result => ({ ok: false, stdout: '', stderr });

/** A registry and a git remote that move forward as the steps run. Every
 * command is answered here: neither npm nor git is started.
 */
const setup = part(() => {
  const state = {
    target: { name: '', repo: '', root: '' } as Target,
    npm: '',
    user: null as string | null,
    published: false,
    /** Whether npm recorded the commit the seed was published from. */
    recorded: true,
    trusted: false,
    tagLocal: false,
    tagRemote: false,
    clean: true,
    head: '',
    main: '',
    confirms: true,
    unreachable: undefined as string | undefined,
    ran: [] as string[],
    logs: [] as string[],
    recent: undefined as boolean | undefined,
    steps: [] as string[],
  };
  const exec: Exec = {
    capture(command) {
      const line = command.join(' ');
      if (state.unreachable !== undefined)
        return no(command[0] === 'npm' ? state.unreachable : '');
      if (line === 'npm --version') return ok(state.npm);
      if (line === 'npm whoami')
        return state.user ? ok(state.user) : no('ENEEDAUTH');
      if (line.endsWith('gitHead'))
        return state.published ? ok(state.recorded ? state.main : '') : no();
      if (line.startsWith('npm view'))
        return state.published
          ? ok(state.target.name)
          : no('npm error code E404');
      if (line.startsWith('npm trust list'))
        return ok(
          state.trusted
            ? `{"repository":"${state.target.repo}","file":"release.yml"}`
            : '[]'
        );
      if (line.startsWith('git fetch')) return ok();
      if (line === 'git rev-parse HEAD') return ok(state.head);
      if (line === 'git rev-parse origin/main') return ok(state.main);
      if (line.startsWith('git rev-parse --verify'))
        return state.tagLocal ? ok(state.main) : no();
      if (line.startsWith('git ls-remote'))
        return ok(state.tagRemote ? `${state.main}\trefs/tags/${seedTag}` : '');
      if (line === 'git status --porcelain')
        return ok(state.clean ? '' : ' M x');
      if (line.startsWith('git tag')) {
        state.ran.push(line);
        state.tagLocal = true;
        return ok();
      }
      throw new Error(`unexpected capture: ${line}`);
    },
    interactive(command) {
      const line = command.join(' ');
      state.ran.push(line);
      if (line.startsWith('npm login')) state.user = 'someone';
      if (line.startsWith('npm trust github')) state.trusted = true;
      if (line.startsWith('git push')) state.tagRemote = true;
      return true;
    },
  };
  const deps: Deps = {
    exec,
    log: (line) => void state.logs.push(line),
    ask: () => Promise.resolve(state.confirms),
    seed: () => {
      state.ran.push(SEED);
      state.published = true;
      return true;
    },
  };
  return { state, exec, deps };
});

Given(
  'the package {string} of the repository {string}, checked out at {string}',
  (world, name: string, repo: string, root: string) => {
    setup(world).state.target = { name, repo, root };
  }
);

Given('npm {word} is installed', (world, version: string) => {
  setup(world).state.npm = version;
});

Given(
  'a clean checkout of main, at the commit {string}',
  (world, commit: string) => {
    Object.assign(setup(world).state, { head: commit, main: commit });
  }
);

Given('{string} is signed in to npm', (world, user: string) => {
  setup(world).state.user = user;
});

Given('the seed version is published', (world) => {
  setup(world).state.published = true;
});

Given(
  'the seed version is published, and npm recorded no commit for it',
  (world) => {
    Object.assign(setup(world).state, { published: true, recorded: false });
  }
);

Given('the Release workflow is trusted to publish the package', (world) => {
  setup(world).state.trusted = true;
});

Given('the seed tag exists here and on the remote', (world) => {
  Object.assign(setup(world).state, { tagLocal: true, tagRemote: true });
});

Given('the working tree has uncommitted changes', (world) => {
  setup(world).state.clean = false;
});

Given('the checkout is at the commit {string}', (world, commit: string) => {
  setup(world).state.head = commit;
});

Given('the person answers no when asked to confirm', (world) => {
  setup(world).state.confirms = false;
});

Given(
  'no command succeeds, and every npm command says {string}',
  (world, error: string) => {
    setup(world).state.unreachable = error;
  }
);

When('the setup is run with {string}', async (world, flags: string) => {
  const { state, deps } = setup(world);
  const given = flags.split(' ');
  await world.attempt(async () => {
    world.exit = await bootstrap(deps, state.target, {
      yes: given.includes('--yes'),
      skipCheck: given.includes('--skip-check'),
    });
  });
});

Then('it runs, in order:', (world, table: DataTable) => {
  expect(setup(world).state.ran).toEqual(table.list());
});

Then('it runs nothing', (world) => {
  expect(setup(world).state.ran).toEqual([]);
});

Then('the first thing it runs starts with {string}', (world, start: string) => {
  expect(setup(world).state.ran[0]).toStartWith(start);
});

Then('it does not publish the seed version', (world) => {
  expect(setup(world).state.ran).not.toContain(SEED);
});

Then('the last thing it says contains {string}', (world, text: string) => {
  expect(setup(world).state.logs.at(-1)).toContain(text);
});

When('npm reports the version {string}', (world, version: string) => {
  setup(world).state.recent = npmIsRecent(version);
});

When('npm reports no version', (world) => {
  setup(world).state.recent = npmIsRecent(null);
});

Then(
  /^npm is (recent enough|too old) to trust a workflow$/,
  (world, verdict: string) => {
    expect(setup(world).state.recent).toBe(verdict === 'recent enough');
  }
);

When('what is already done is measured', async (world) => {
  const { state, exec } = setup(world);
  await world.attempt(() => measure(exec, state.target));
});

When('the setup is planned', (world) => {
  const { state, exec } = setup(world);
  state.steps = plan(measure(exec, state.target)).map((step) => step.id);
});

Then('the plan has these steps, in order:', (world, table: DataTable) => {
  expect(setup(world).state.steps).toEqual(table.list());
});

// ── The version of a release ─────────────────────────────────────────────

const release = part(() => ({
  tags: [] as string[],
  released: false,
  messages: [] as string[],
  npm: [] as string[],
  bump: undefined as Bump | undefined,
  version: undefined as string | undefined,
  latest: undefined as string | null | undefined,
  decision: undefined as Decision | undefined,
}));

/** git as the release sees it: its tags, whether HEAD is in the last
 * release, and the commit messages since.
 */
const git =
  (world: BootstrapWorld): Git =>
  (args) => {
    const state = release(world);
    const [command] = args;
    if (command === 'tag') return state.tags.join('\n');
    if (command === 'merge-base') return state.released ? '' : null;
    if (command === 'log')
      return state.messages.map((message) => `${message}\n\0`).join('\n');
    return null;
  };

When(/^these commits are released: (.+)$/, (world, commits: string) => {
  release(world).bump = bumpFor(quoted(commits));
});

When('a commit with this message is released:', (world, message: string) => {
  release(world).bump = bumpFor([message]);
});

Then('the bump is {string}', (world, bump: string) => {
  expect(release(world).bump).toBe(bump as Bump);
});

When(
  'the release {string} is given a {string} bump',
  async (world, tag: string, bump: Bump) => {
    await world.attempt(() => {
      release(world).version = bumpVersion(tag, bump);
    });
  }
);

Then('the next version is {string}', (world, version: string) => {
  expect(release(world).version).toBe(version);
});

Given(/^git lists the tags (.+), newest first$/, (world, tags: string) => {
  release(world).tags = quoted(tags);
});

Given('git lists no tags', (world) => {
  release(world).tags = [];
});

Given('HEAD is already in the last release', (world) => {
  release(world).released = true;
});

Given(/^the commits since the last tag are (.+)$/, (world, commits: string) => {
  release(world).messages = quoted(commits);
});

When('the last release is looked up', (world) => {
  release(world).latest = latestTag(git(world));
});

Then('the last release is {string}', (world, tag: string) => {
  expect(release(world).latest).toBe(tag);
});

Then('there is no last release', (world) => {
  expect(release(world).latest).toBeNull();
});

Given(/^npm holds the versions (.+)$/, (world, versions: string) => {
  release(world).npm = quoted(versions);
});

When('the release is decided', (world) => {
  release(world).decision = decide(
    git(world),
    newestPublished(release(world).npm)
  );
});

Then('the run fails, because publishing was never set up', (world) => {
  const decision = release(world).decision!;
  expect(decision.release ? undefined : decision.setup).toBe(true);
});

Then('nothing is released', (world) => {
  expect(release(world).decision!.release).toBe(false);
});

Then('the reason given mentions {string}', (world, text: string) => {
  const decision = release(world).decision!;
  expect(decision.release ? undefined : decision.reason).toContain(text);
});

Then('nothing is released, because {string}', (world, reason: string) => {
  expect(release(world).decision).toEqual({ release: false, reason });
});

Then(
  'the version {string} is released, after {string}',
  (world, version: string, previous: string) => {
    expect(release(world).decision).toEqual({
      release: true,
      version,
      previous,
    });
  }
);
