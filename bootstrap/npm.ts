/**
 * `bun run bootstrap`: the one-time npm setup for publishing this package.
 *
 * npm can publish new versions through OIDC but cannot create a package that
 * does not exist yet. So once, with your own npm login: publish the seed
 * version, make the Release workflow the package's trusted publisher, and tag
 * the commit that was published. Every step measures first and skips what is
 * already done, so it is safe to run again after any interruption.
 *
 *   bun run bootstrap              walk through and do it
 *   bun run bootstrap --yes        do not ask before publishing
 *   bun run bootstrap --skip-check do not run `bun run check` first
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';

export const SEED_VERSION = '0.1.0';
export const WORKFLOW_FILE = 'release.yml';
const MIN_NPM = [11, 10] as const;

export interface Exec {
  /** Run quietly and return the output. */
  capture(command: string[], cwd?: string): Result;
  /** Run with the terminal attached, for prompts and browser sign-in. */
  interactive(command: string[], cwd?: string): boolean;
}

export interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface Target {
  /** `@scope/name` from package.json. */
  name: string;
  /** `owner/repo` from package.json. */
  repo: string;
  root: string;
}

export interface State {
  npmVersion: string | null;
  user: string | null;
  published: boolean;
  /** Null until the package exists: there is nothing to look at yet. */
  trusted: boolean | null;
  tagLocal: boolean;
  tagRemote: boolean;
  /** Commit npm recorded for the seed version, when it was published. */
  publishedCommit: string | null;
  clean: boolean;
  onMain: boolean;
}

export type StepId = 'login' | 'publish' | 'trust' | 'tag';

export interface Step {
  id: StepId;
  title: string;
  done: boolean;
  /** Why the step cannot run right now. */
  blocked: string | null;
}

export const seedTag = `v${SEED_VERSION}`;

export function readTarget(root: string): Target {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  ) as { name: string; repository: string };
  return {
    name: manifest.name,
    repo: manifest.repository.replace(/^github:/, ''),
    root,
  };
}

export function npmIsRecent(version: string | null): boolean {
  const [major = 0, minor = 0] = (version ?? '').split('.').map(Number);
  return major > MIN_NPM[0] || (major === MIN_NPM[0] && minor >= MIN_NPM[1]);
}

export function measure(exec: Exec, target: Target): State {
  const { name, repo, root } = target;
  const npm = exec.capture(['npm', '--version']);
  const whoami = exec.capture(['npm', 'whoami']);
  const view = exec.capture([
    'npm',
    'view',
    `${name}@${SEED_VERSION}`,
    'gitHead',
  ]);
  const any = exec.capture(['npm', 'view', name, 'name']);
  if (!any.ok && !/E404/.test(any.stderr))
    throw new Error('Could not reach the npm registry. Check the network.');
  const published = any.ok;
  const trust = published
    ? exec.capture(['npm', 'trust', 'list', name, '--json'])
    : null;
  exec.capture(['git', 'fetch', '--quiet', 'origin', 'main', '--tags'], root);
  const head = exec.capture(['git', 'rev-parse', 'HEAD'], root).stdout.trim();
  const main = exec
    .capture(['git', 'rev-parse', 'origin/main'], root)
    .stdout.trim();
  return {
    npmVersion: npm.ok ? npm.stdout.trim() : null,
    user: whoami.ok ? whoami.stdout.trim() : null,
    published,
    trusted: trust
      ? trust.ok &&
        trust.stdout.includes(repo) &&
        trust.stdout.includes(WORKFLOW_FILE)
      : null,
    tagLocal: exec.capture(
      ['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${seedTag}`],
      root
    ).ok,
    tagRemote:
      exec
        .capture(
          ['git', 'ls-remote', '--tags', 'origin', `refs/tags/${seedTag}`],
          root
        )
        .stdout.trim() !== '',
    publishedCommit: view.ok ? view.stdout.trim() || null : null,
    clean:
      exec.capture(['git', 'status', '--porcelain'], root).stdout.trim() === '',
    onMain: head !== '' && head === main,
  };
}

export function plan(state: State): Step[] {
  const needsLogin = state.user === null;
  const publishBlocked = !state.clean
    ? 'The working tree has uncommitted changes; the seed is published from a commit.'
    : !state.onMain
      ? 'HEAD is not origin/main. Merge the change, then run this on main.'
      : null;
  return [
    {
      id: 'login',
      title: 'Sign in to npm',
      done: !needsLogin,
      blocked: null,
    },
    {
      id: 'publish',
      title: `Publish ${SEED_VERSION}, the seed version`,
      done: state.published,
      blocked: state.published ? null : publishBlocked,
    },
    {
      id: 'trust',
      title: `Trust ${WORKFLOW_FILE} to publish every later version`,
      done: state.trusted === true,
      blocked: null,
    },
    {
      id: 'tag',
      title: `Tag ${seedTag} on the commit that was published`,
      done: state.tagRemote,
      blocked: null,
    },
  ];
}

export interface Deps {
  exec: Exec;
  /** Publish the seed version from a checkout of HEAD. */
  seed(target: Target): boolean;
  log(line: string): void;
  ask(question: string): Promise<boolean>;
}

interface Options {
  yes: boolean;
  skipCheck: boolean;
}

function show(deps: Deps, state: State, steps: Step[]): void {
  deps.log(
    `npm ${state.npmVersion ?? 'missing'} · ${state.user ? `signed in as ${state.user}` : 'not signed in'}`
  );
  for (const step of steps)
    deps.log(
      `${step.done ? '✓' : step.blocked ? '✗' : '→'} ${step.title}${step.blocked ? ` (${step.blocked})` : ''}`
    );
}

/** Publish from a throwaway checkout of HEAD so the working tree is never
 * edited and npm records the commit it published.
 */
function publishSeed(exec: Exec, target: Target): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'dev-fleet-seed-'));
  const checkout = join(dir, 'checkout');
  try {
    exec.capture(
      ['git', 'worktree', 'add', '--detach', checkout, 'HEAD'],
      target.root
    );
    const file = join(checkout, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as object;
    // As the Release workflow does: the package names the commit it is.
    const gitHead = exec
      .capture(['git', 'rev-parse', 'HEAD'], checkout)
      .stdout.trim();
    writeFileSync(
      file,
      `${JSON.stringify({ ...manifest, version: SEED_VERSION, gitHead }, null, 2)}\n`
    );
    return exec.interactive(['npm', 'publish', '--access', 'public'], checkout);
  } finally {
    exec.capture(
      ['git', 'worktree', 'remove', '--force', checkout],
      target.root
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

function tagPublished(exec: Exec, target: Target, state: State): boolean {
  const commit =
    state.publishedCommit ??
    exec
      .capture(['npm', 'view', `${target.name}@${SEED_VERSION}`, 'gitHead'])
      .stdout.trim();
  if (!commit) return false;
  if (!state.tagLocal)
    exec.capture(['git', 'tag', seedTag, commit], target.root);
  return exec.interactive(
    ['git', 'push', 'origin', `refs/tags/${seedTag}`],
    target.root
  );
}

export async function bootstrap(
  deps: Deps,
  target: Target,
  options: Options
): Promise<number> {
  const { exec, log } = deps;
  let state = measure(exec, target);
  const steps = plan(state);
  show(deps, state, steps);
  if (!npmIsRecent(state.npmVersion)) {
    log(
      `npm ${MIN_NPM.join('.')} or newer is required (for "npm trust"). Run: npm install -g npm@latest`
    );
    return 1;
  }
  const todo = steps.filter((step) => !step.done);
  if (todo.length === 0) {
    log('Nothing to do: publishing is bootstrapped.');
    return 0;
  }
  const blocked = todo.find((step) => step.blocked);
  if (blocked) return 1;
  if (
    !options.yes &&
    !(await deps.ask(`Run ${todo.length} step(s) as listed?`))
  )
    return 130;
  if (todo.some((s) => s.id === 'publish') && !options.skipCheck) {
    log('Running bun run check before publishing…');
    if (!exec.interactive(['bun', 'run', 'check'], target.root)) return 1;
  }
  for (const step of todo) {
    log(`→ ${step.title}`);
    if (!(await run(step.id, deps, target, state))) {
      log(`✗ ${step.title} failed; run bun run bootstrap again to continue.`);
      return 1;
    }
    state = measure(exec, target);
  }
  show(deps, state, plan(state));
  return plan(state).every((step) => step.done) ? 0 : 1;
}

async function run(
  id: StepId,
  deps: Deps,
  target: Target,
  state: State
): Promise<boolean> {
  const { exec } = deps;
  switch (id) {
    case 'login':
      return exec.interactive(['npm', 'login', '--auth-type=web']);
    case 'publish':
      return deps.seed(target);
    case 'trust':
      return exec.interactive([
        'npm',
        'trust',
        'github',
        target.name,
        '--repo',
        target.repo,
        '--file',
        WORKFLOW_FILE,
        '--allow-publish',
        '--yes',
      ]);
    case 'tag':
      return tagPublished(exec, target, state);
  }
}

const system: Exec = {
  capture(command, cwd) {
    const result = spawnSync(command[0]!, command.slice(1), {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf8',
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  },
  interactive(command, cwd) {
    const result = spawnSync(command[0]!, command.slice(1), {
      ...(cwd ? { cwd } : {}),
      stdio: 'inherit',
    });
    return result.status === 0;
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: Options = {
    yes: args.includes('--yes'),
    skipCheck: args.includes('--skip-check'),
  };
  if (!options.yes && !process.stdin.isTTY) {
    console.error('Not a terminal: pass --yes to run unattended.');
    process.exit(2);
  }
  process.exitCode = await bootstrap(
    {
      exec: system,
      seed: (target) => publishSeed(system, target),
      log: (line) => console.log(line),
      ask: (message) => confirm({ message, default: true }),
    },
    readTarget(resolve(import.meta.dir, '..')),
    options
  );
}
