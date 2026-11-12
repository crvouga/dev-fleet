import { expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ide, ROOT, type IdeWorld } from './world';

const { Given, When, Then } = ide;

const guard = join(ROOT, 'ansible/ubuntu/wip-guard.py');

interface Place {
  root: string;
  remote: string;
  worktree: string;
  head?: string;
}
const places = new WeakMap<IdeWorld, Place>();
const place = (world: IdeWorld): Place => places.get(world)!;

function git(cwd: string, ...args: string[]): string {
  return raw(cwd, ...args).trim();
}

function raw(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(['git', '-c', 'safe.directory=*', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString();
}

Given(
  'an agent worktree on the branch {string} whose remote holds its first commit',
  (world, branch: string) => {
    const base = world.directory('ide-wip-');
    const remote = join(base, 'remote.git');
    const root = join(base, 'worktrees');
    const worktree = join(root, 'project', 'task');
    mkdirSync(worktree, { recursive: true });
    git(base, 'init', '--quiet', '--bare', remote);
    git(worktree, 'init', '--quiet', '-b', branch);
    writeFileSync(join(worktree, 'README.md'), 'first\n');
    git(worktree, 'add', 'README.md');
    git(worktree, 'commit', '--quiet', '-m', 'first');
    git(worktree, 'remote', 'add', 'origin', remote);
    git(worktree, 'push', '--quiet', '-u', 'origin', branch);
    places.set(world, { root, remote, worktree });
  }
);

Given(
  'the worktree has a changed file {string} and a new file {string}',
  (world, changed: string, created: string) => {
    writeFileSync(join(place(world).worktree, changed), 'changed\n');
    writeFileSync(join(place(world).worktree, created), 'new\n');
  }
);

Given('the worktree has a commit that was never pushed', (world) => {
  const { worktree } = place(world);
  writeFileSync(join(worktree, 'README.md'), 'second\n');
  git(worktree, 'commit', '--quiet', '-am', 'second');
});

When(
  'the work-in-progress guard runs for the worker {string}',
  (world, node: string) => {
    place(world).head = git(place(world).worktree, 'rev-parse', 'HEAD');
    const out = Bun.spawnSync(
      ['python3', '-B', guard, '--root', place(world).root, '--node', node],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    expect(out.exitCode).toBe(0);
  }
);

const recovery = (world: IdeWorld): string[] =>
  git(
    place(world).remote,
    'for-each-ref',
    '--format=%(refname)',
    'refs/recovery'
  )
    .split('\n')
    .filter(Boolean);

Then('the remote holds {string}', (world, ref: string) => {
  expect(recovery(world)).toEqual([ref]);
});

Then('the remote holds no recovery ref', (world) => {
  expect(recovery(world)).toEqual([]);
});

Then(
  'that ref holds {string} as changed and {string}',
  (world, changed: string, created: string) => {
    const [ref] = recovery(world);
    const { remote } = place(world);
    expect(git(remote, 'show', `${ref}:${changed}`)).toBe('changed');
    expect(git(remote, 'show', `${ref}:${created}`)).toBe('new');
  }
);

Then(
  'the worktree still shows {string} as changed and {string} as new',
  (world, changed: string, created: string) => {
    expect(
      raw(place(world).worktree, 'status', '--porcelain')
        .split('\n')
        .filter(Boolean)
        .sort()
    ).toEqual([` M ${changed}`, `?? ${created}`].sort());
  }
);

Then('the branch {string} did not move', (world, branch: string) => {
  expect(git(place(world).worktree, 'rev-parse', branch)).toBe(
    place(world).head!
  );
});

Then(
  'the remote holds {string} at the branch {string}',
  (world, ref: string, branch: string) => {
    expect(recovery(world)).toEqual([ref]);
    expect(git(place(world).remote, 'rev-parse', ref)).toBe(
      git(place(world).worktree, 'rev-parse', branch)
    );
  }
);

interface Task {
  name?: string;
  'ansible.builtin.copy'?: { dest: string; content: string };
  'ansible.builtin.systemd_service'?: { name: string; enabled: boolean };
}
const tasks = new WeakMap<IdeWorld, Task[]>();

When('the worker recovery tasks are read', (world) => {
  tasks.set(
    world,
    parse(
      readFileSync(join(ROOT, 'ansible/ubuntu/tasks/recovery.yml'), 'utf8')
    ) as Task[]
  );
});

Then(
  'they install the timer {string} that runs {string} every {string}',
  (world, timer: string, script: string, every: string) => {
    const all = tasks.get(world)!;
    const copy = (suffix: string) =>
      all.find((task) => task['ansible.builtin.copy']?.dest.endsWith(suffix))?.[
        'ansible.builtin.copy'
      ]?.content ?? '';
    expect(copy(timer)).toContain(`OnUnitActiveSec=${every}`);
    expect(copy(timer.replace('.timer', '.service'))).toContain(script);
    expect(
      all.some(
        (task) =>
          task['ansible.builtin.systemd_service']?.name === timer &&
          task['ansible.builtin.systemd_service'].enabled
      )
    ).toBe(true);
  }
);
