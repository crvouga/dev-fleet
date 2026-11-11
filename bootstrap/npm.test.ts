import { expect, test } from 'bun:test';
import {
  bootstrap,
  measure,
  npmIsRecent,
  plan,
  seedTag,
  type Deps,
  type Exec,
  type Target,
} from './npm';

const target: Target = {
  name: '@scope/pkg',
  repo: 'owner/repo',
  root: '/repo',
};
const COMMIT = 'a'.repeat(40);

/** A registry and a git remote that move forward as the steps run. */
function world(initial: Partial<Record<string, unknown>> = {}) {
  const w = {
    user: null as string | null,
    published: false,
    trusted: false,
    tagLocal: false,
    tagRemote: false,
    clean: true,
    head: COMMIT,
    main: COMMIT,
    npm: '11.20.0',
    ...initial,
  };
  const ran: string[] = [];
  const ok = (
    stdout = ''
  ): { ok: boolean; stdout: string; stderr: string } => ({
    ok: true,
    stdout,
    stderr: '',
  });
  const no = (
    stderr = ''
  ): { ok: boolean; stdout: string; stderr: string } => ({
    ok: false,
    stdout: '',
    stderr,
  });
  const exec: Exec = {
    capture(command) {
      const line = command.join(' ');
      if (line === 'npm --version') return ok(w.npm);
      if (line === 'npm whoami') return w.user ? ok(w.user) : no('ENEEDAUTH');
      if (line.endsWith('gitHead')) return w.published ? ok(COMMIT) : no();
      if (line.startsWith('npm view'))
        return w.published ? ok('@scope/pkg') : no('npm error code E404');
      if (line.startsWith('npm trust list'))
        return ok(
          w.trusted ? '{"repository":"owner/repo","file":"release.yml"}' : '[]'
        );
      if (line.startsWith('git fetch')) return ok();
      if (line === 'git rev-parse HEAD') return ok(w.head);
      if (line === 'git rev-parse origin/main') return ok(w.main);
      if (line.startsWith('git rev-parse --verify'))
        return w.tagLocal ? ok(COMMIT) : no();
      if (line.startsWith('git ls-remote'))
        return ok(w.tagRemote ? `${COMMIT}\trefs/tags/${seedTag}` : '');
      if (line === 'git status --porcelain') return ok(w.clean ? '' : ' M x');
      if (line.startsWith('git tag')) {
        ran.push(line);
        w.tagLocal = true;
        return ok();
      }
      throw new Error(`unexpected capture: ${line}`);
    },
    interactive(command) {
      const line = command.join(' ');
      ran.push(line);
      if (line.startsWith('npm login')) w.user = 'someone';
      if (line.startsWith('npm trust github')) w.trusted = true;
      if (line.startsWith('git push')) w.tagRemote = true;
      return true;
    },
  };
  const deps: Deps & { logs: string[] } = {
    exec,
    logs: [],
    log: (line) => deps.logs.push(line),
    ask: () => Promise.resolve(true),
    seed: () => {
      ran.push('seed');
      w.published = true;
      return true;
    },
  };
  return { w, ran, deps };
}

const options = { yes: true, skipCheck: true };

test('a fresh setup signs in, publishes the seed, trusts the workflow and tags the published commit, in order', async () => {
  const { ran, deps } = world();
  expect(await bootstrap(deps, target, options)).toBe(0);
  expect(ran).toEqual([
    'npm login --auth-type=web',
    'seed',
    'npm trust github @scope/pkg --repo owner/repo --file release.yml --allow-publish --yes',
    `git tag ${seedTag} ${COMMIT}`,
    `git push origin refs/tags/${seedTag}`,
  ]);
});

test('running it again after it finished changes nothing', async () => {
  const { ran, deps } = world({
    user: 'someone',
    published: true,
    trusted: true,
    tagLocal: true,
    tagRemote: true,
  });
  expect(await bootstrap(deps, target, options)).toBe(0);
  expect(ran).toEqual([]);
  expect(deps.logs.at(-1)).toContain('Nothing to do');
});

test('an interrupted run resumes at the first step that is not done', async () => {
  const { ran, deps } = world({ user: 'someone', published: true });
  expect(await bootstrap(deps, target, options)).toBe(0);
  expect(ran[0]).toStartWith('npm trust github');
  expect(ran).not.toContain('seed');
});

test('it will not publish from uncommitted work or a commit that is not main', async () => {
  for (const initial of [{ clean: false }, { head: 'b'.repeat(40) }]) {
    const { ran, deps } = world({ user: 'someone', ...initial });
    expect(await bootstrap(deps, target, options)).toBe(1);
    expect(ran).toEqual([]);
  }
});

test('declining the confirmation runs nothing', async () => {
  const { ran, deps } = world();
  deps.ask = () => Promise.resolve(false);
  expect(await bootstrap(deps, target, { ...options, yes: false })).toBe(130);
  expect(ran).toEqual([]);
});

test('an old npm is refused before anything runs, and the registry being down is not "unpublished"', () => {
  expect(npmIsRecent('11.9.9')).toBe(false);
  expect(npmIsRecent('11.10.0')).toBe(true);
  expect(npmIsRecent('12.0.0')).toBe(true);
  expect(npmIsRecent(null)).toBe(false);
  const { deps } = world();
  deps.exec.capture = (command) => ({
    ok: false,
    stdout: '',
    stderr: command[0] === 'npm' ? 'ECONNREFUSED' : '',
  });
  expect(() => measure(deps.exec, target)).toThrow('npm registry');
  expect(plan(measure(world().deps.exec, target)).map((s) => s.id)).toEqual([
    'login',
    'publish',
    'trust',
    'tag',
  ]);
});
