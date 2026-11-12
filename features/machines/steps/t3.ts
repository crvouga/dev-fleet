import { expect } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  T3_RESTARTED_SUMMARY,
  loadedT3Policy,
  stableWorkspace,
  verifyT3Policy,
  workerPolicy,
} from '../../../src/platform/t3-policy';
import { convergeT3Route } from '../../../src/platform/t3-route';
import {
  convergeT3Service,
  runningVersionCheck,
  t3RestartMarker,
} from '../../../src/platform/t3-service';
import { succeeded } from '../../support/commands';
import { commandLine } from '../../support/answers';
import type { DataTable } from '../../support/gherkin';
import { machines, temporary } from './world';

const { Given, When, Then } = machines;

// ── The policy T3 has loaded ─────────────────────────────────────────────

When(
  'the policy loaded by the T3 at {string} is measured',
  async (world, executable: string) => {
    world.checks = [
      await verifyT3Policy(executable, world.run, async () => {
        world.pauses++;
      }),
    ];
  }
);

When(
  /^the policy loaded by the T3 at "([^"]+)" is measured after a play that (restarted it|left it running)$/,
  async (world, executable: string, play: string) => {
    world.checks = [
      await loadedT3Policy(executable, world.run, {
        restarted: play === 'restarted it',
        uid: 1000,
        pause: async () => {
          world.pauses++;
        },
      }),
    ];
  }
);

Given(
  'a restart of T3 has been deferred for {int} hours',
  (world, hours: number) => {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    world.commands.answer(
      commandLine(`cat ${t3RestartMarker(1000)}`),
      succeeded(`${since}\n`)
    );
  }
);

Then('the measurement paused {int} times', (world, count: number) => {
  expect(world.pauses).toBe(count);
});

Then('that summary is the one the manager takes as a restart', (world) => {
  expect(world.check.summary).toBe(T3_RESTARTED_SUMMARY);
});

Then(
  'the summary of the check is not the one the manager takes as a restart',
  (world) => {
    expect(world.check.summary).not.toBe(T3_RESTARTED_SUMMARY);
  }
);

// ── The desktop app ──────────────────────────────────────────────────────

Given(
  'the pinned T3 release is {string}, installed at {string}',
  (world, version: string, path: string) => {
    world.artifact = { path, version };
  }
);

Given('installing the desktop app fails', (world) => {
  world.installs = false;
});

When("the worker's T3 desktop app is converged", async (world) => {
  world.checks = await convergeT3Service(world.artifact, world.run, {
    prepare: async () => {
      world.staged = true;
      return [];
    },
    install: async () => {
      world.installed = true;
      return world.installs;
    },
  });
});

Given('installing the T3 server fails', (world) => {
  world.installs = false;
});

When("the headless worker's T3 server is converged", async (world) => {
  world.checks = await convergeT3Service(world.artifact, world.run, {
    prepare: async () => {
      world.staged = true;
      return [];
    },
    install: async () => {
      world.installed = true;
      return world.installs;
    },
    session: 'headless',
  });
});

When('the release of the T3 of a headless worker is checked', async (world) => {
  world.checks = [
    await runningVersionCheck(world.run, 1000, Date.now(), 'headless'),
  ];
});

/** The user unit a playbook declares, by the path it writes it to. */
function declaredUnit(playbook: string, unit: string): string {
  const plays = parse(
    readFileSync(resolve(import.meta.dir, '../../..', playbook), 'utf8')
  ) as {
    tasks: { 'ansible.builtin.copy'?: { dest?: string; content?: string } }[];
  }[];
  const task = plays[0]!.tasks.find((entry) =>
    entry['ansible.builtin.copy']?.dest?.endsWith(`/${unit}`)
  );
  return task?.['ansible.builtin.copy']?.content ?? '';
}

Then(
  '{string} declares the unit {string} with these lines:',
  (_world, playbook: string, unit: string, table: DataTable) => {
    const lines = declaredUnit(playbook, unit).split('\n');
    for (const line of table.list()) expect(lines).toContain(line);
  }
);

Then(
  '{string} declares the unit {string} with no line containing {string}',
  (_world, playbook: string, unit: string, text: string) => {
    const content = declaredUnit(playbook, unit);
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain(text);
  }
);

const composed = new WeakMap<object, ReturnType<typeof workerPolicy>>();

When(
  'the policy for a worker with the provider instance {string} is composed',
  (world, instance: string) => {
    composed.set(world, workerPolicy({ [instance]: { driver: instance } }));
  }
);

Then('the policy sets these settings:', (world, table: DataTable) => {
  const settings = composed.get(world)!.settings as Record<string, unknown>;
  expect(settings).toEqual(
    Object.fromEntries(
      table.hashes().map((row) => [
        row['setting']!,
        {
          value: JSON.parse(row['value']!) as unknown,
          locked: row['locked'] === 'true',
        },
      ])
    )
  );
});

Then('the policy was not staged', (world) => {
  expect(world.staged).toBe(false);
});

Then('the desktop app was not installed', (world) => {
  expect(world.installed).toBe(false);
});

// ── The private route ────────────────────────────────────────────────────

Given(/^publishing the route (succeeds|fails)$/, (world, outcome: string) => {
  world.publishes = outcome === 'succeeds';
});

Given(
  'until the route is published the command {string} prints {string}, and afterwards:',
  (world, command: string, before: string, after: string) => {
    world.commands.answer(commandLine(command), () =>
      succeeded(world.published ? after : before)
    );
  }
);

When("the worker's private T3 route is converged", async (world) => {
  world.checks = await convergeT3Route(world.run, async () => {
    world.publishAsked = true;
    world.published = world.publishes;
    return world.publishes;
  });
});

Then(/^the route was (published|not published)$/, (world, outcome: string) => {
  expect(world.publishAsked).toBe(outcome === 'published');
});

// ── The workspace link ───────────────────────────────────────────────────

const revision = (fleet: string, commit: string): string =>
  join(fleet, 'revisions', commit);

Given(
  'a fleet directory that holds the revisions {string} and {string}',
  async (world, first: string, second: string) => {
    world.directory = await temporary(world, 'fleet-');
    for (const commit of [first, second])
      await mkdir(revision(world.directory, commit), { recursive: true });
  }
);

Given(
  'the revision {string} is the one T3 references',
  async (world, commit: string) => {
    world.before = await stableWorkspace(revision(world.directory, commit));
  }
);

When(
  'the revision {string} becomes the one T3 references',
  async (world, commit: string) => {
    world.referenced = await stableWorkspace(revision(world.directory, commit));
  }
);

When(
  'the checkout {string} becomes the one T3 references',
  async (world, checkout: string) => {
    world.referenced = await stableWorkspace(checkout);
  }
);

Then('T3 references {string} in the fleet directory', (world, name: string) => {
  expect(world.referenced).toBe(join(world.directory, name));
});

Then('T3 references {string}', (world, path: string) => {
  expect(world.referenced).toBe(path);
});

Then('T3 references the same path as before', (world) => {
  expect(world.before).not.toBe('');
  expect(world.referenced).toBe(world.before);
});

Then(
  '{string} links to {string}',
  async (world, name: string, target: string) => {
    expect(await readlink(join(world.directory, name))).toBe(
      join(...target.split('/'))
    );
  }
);

Then(
  '{string} resolves to the revision {string}',
  async (world, name: string, commit: string) => {
    expect(await realpath(join(world.directory, name))).toBe(
      await realpath(revision(world.directory, commit))
    );
  }
);

// ── The recovery watchdog ────────────────────────────────────────────────

interface Task {
  'ansible.builtin.copy'?: { src?: string; dest: string; content?: string };
  loop?: string[];
}
const ubuntu = resolve(import.meta.dir, '../../../ansible/ubuntu');
const recoveryTasks = (): Task[] =>
  parse(readFileSync(join(ubuntu, 'tasks/recovery.yml'), 'utf8')) as Task[];
/** The ExecStart of the recovery unit, as the role writes it. */
const execStart = (): string => {
  const unit = recoveryTasks().find((task) =>
    task['ansible.builtin.copy']?.dest.endsWith(
      'personal-worker-recovery.service'
    )
  );
  const line = /^ExecStart=(.*)$/m.exec(
    unit?.['ansible.builtin.copy']?.content ?? ''
  );
  if (!line?.[1]) throw new Error('The recovery unit has no ExecStart.');
  return line[1];
};

Given(
  'a revision installed the recovery watchdog as the role declares it',
  async (world) => {
    world.directory = await temporary(world, 'recovery-');
    const revision = join(world.directory, 'revisions/abc/ansible/ubuntu');
    await mkdir(revision, { recursive: true });
    for (const name of readdirSync(ubuntu))
      if (/\.(sh|py)$/.test(name))
        copyFileSync(join(ubuntu, name), join(revision, name));
    for (const task of recoveryTasks()) {
      const copy = task['ansible.builtin.copy'];
      if (!copy?.src) continue;
      for (const item of task.loop ?? []) {
        const render = (text: string) =>
          text
            .replaceAll('{{ playbook_dir }}', revision)
            .replaceAll('{{ item }}', item);
        const dest = join(world.directory, 'root', render(copy.dest));
        await mkdir(dirname(dest), { recursive: true });
        copyFileSync(render(copy.src), dest);
      }
    }
  }
);

Given('that revision has been pruned', async (world) => {
  await rm(join(world.directory, 'revisions'), {
    recursive: true,
    force: true,
  });
});

When('the recovery unit runs', (world) => {
  const bin = join(world.directory, 'bin');
  mkdirSync(bin, { recursive: true });
  // A healthy desktop app in a graphical session.
  for (const name of ['systemctl', 'curl']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  const [shell, script] = execStart().split(' ');
  const ran = Bun.spawnSync([shell!, join(world.directory, 'root', script!)], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: world.directory,
      HOME: world.directory,
    },
  });
  world.ran = String(ran.exitCode);
});

Then('the recovery unit succeeds', (world) => {
  expect(world.ran).toBe('0');
});

When('the recovery unit the role declares is read', (world) => {
  world.ran = execStart();
});

Then('the recovery unit starts {string}', (world, command: string) => {
  expect(world.ran).toBe(command);
});
