import { expect } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import macos from '../../ansible/macos/policy.json';
import ubuntu from '../../ansible/ubuntu/policy.json';
import beszel from '../../ansible/monitoring/lock.json';
import {
  publishedRelease,
  release,
  scheduledCommand,
} from '../../src/cli/fleet-sync-schedule';
import {
  renderSupportMatrix,
  supportMatrix,
} from '../../src/machine/support-matrix';
import { checkOwner } from '../../src/check-owners';
import { REPAIR_RECIPES } from '../../src/repair-catalog';
import { reportedCheckIds } from '../../src/check-registry';
import {
  checkRepair,
  manualReason,
  repairId,
  repairPlan,
} from '../../src/repair-plan';
import { World, scenariosOf, steps, type DataTable } from '../support/gherkin';

const root = resolve(import.meta.dir, '../..');
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8');

async function files(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan(root)) found.push(path);
  return found.sort();
}

type Task = Record<string, unknown>;
interface Located {
  path: string;
  task: Task;
}
interface WorkflowStep {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  name: string;
  on: Record<string, { types?: string[]; workflows?: string[] } | null>;
  concurrency?: { 'cancel-in-progress'?: unknown };
  jobs: Record<
    string,
    {
      if?: string;
      'runs-on'?: string;
      needs?: string | string[];
      uses?: string;
      with?: Record<string, unknown>;
      strategy?: {
        matrix?: Record<string, unknown> & {
          include?: Record<string, string>[];
        };
      };
      services?: Record<string, { image: string }>;
      steps?: WorkflowStep[];
    }
  >;
}

export class RulesWorld extends World {
  tasks: Located[] = [];
  /** What the last "When … is read / searched" step found. */
  found: string[] = [];
  searched = 0;
  conditions: unknown[] = [];
  failure: Error | undefined;
  workflow: Workflow | undefined;
  workflowSteps: WorkflowStep[] = [];
  script = '';
  packed: string[] = [];
  output = '';
  ansibleCore = '';
  /** A copy of the launcher, installed with its own pinned Bun and PATH. */
  installed: { root: string; path: string; status: number | null } | undefined;
  scenarios: {
    path: string;
    name: string;
    keywords: Record<string, number>;
  }[] = [];
}

export const rules = steps<RulesWorld>();
const { Given, When, Then } = rules;

// ── Playbooks ────────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  'name',
  'when',
  'register',
  'loop',
  'loop_control',
  'vars',
  'become',
  'become_user',
  'changed_when',
  'check_mode',
  'failed_when',
  'environment',
  'notify',
  'listen',
  'no_log',
  'retries',
  'delay',
  'until',
  'block',
  'rescue',
  'always',
  'tags',
]);
const NESTED = ['pre_tasks', 'tasks', 'handlers', 'block', 'rescue', 'always'];

/** Every task of a playbook or task file, with the tasks inside its blocks. */
function tasksOf(document: unknown): Task[] {
  if (!Array.isArray(document)) return [];
  return (document as Task[]).flatMap((entry) => {
    const nested = NESTED.flatMap((key) => tasksOf(entry[key]));
    // A play or a block only groups tasks; it runs no module itself.
    return 'hosts' in entry || 'block' in entry ? nested : [entry, ...nested];
  });
}
const moduleOf = (task: Task): string =>
  String(Object.keys(task).find((key) => !KEYWORDS.has(key)));

async function playbooks(): Promise<string[]> {
  return (await files('ansible/**/*.yml')).filter(
    (path) => !path.endsWith('compose.yml')
  );
}

When('every task of every playbook is read', async (world) => {
  for (const path of await playbooks())
    for (const task of tasksOf(parse(read(path))))
      world.tasks.push({ path, task });
});

Then('there are more than {int} tasks', (world, count: number) => {
  expect(world.tasks.length).toBeGreaterThan(count);
});

Then('every task uses an {string} module', (world, collection: string) => {
  const others = world.tasks
    .map(({ path, task }) => `${path}: ${moduleOf(task)}`)
    .filter((entry) => !entry.split(': ')[1]!.startsWith(`${collection}.`));
  expect(others).toEqual([]);
});

Then('no task uses any of these modules:', (world, table: DataTable) => {
  const forbidden = table.list().map((name) => `ansible.builtin.${name}`);
  const offenders = world.tasks
    .filter(({ task }) => forbidden.includes(moduleOf(task)))
    .map(({ path, task }) => `${path}: ${moduleOf(task)}`);
  expect(offenders).toEqual([]);
});

const installs = (world: RulesWorld): { path: string; apt: Task }[] =>
  world.tasks.flatMap(({ path, task }) => {
    const apt = task['ansible.builtin.apt'] as Task | undefined;
    return apt && apt['name'] !== undefined ? [{ path, apt }] : [];
  });

Then(
  'no package is installed in the state {string}',
  (world, state: string) => {
    expect(installs(world).length).toBeGreaterThan(0);
    for (const { apt } of installs(world)) expect(apt['state']).not.toBe(state);
  }
);

Then(
  'only these packages are installed without an exact version:',
  (world, table: DataTable) => {
    // Removing a package (state absent) installs nothing.
    const floating = installs(world)
      .filter(({ apt }) => apt['state'] !== 'absent')
      .filter(({ apt }) => !String(apt['name']).includes('='))
      .map(({ path, apt }) => ({
        playbook: path,
        package: String(apt['name']),
      }));
    const byPlaybook = (a: { playbook: string }, b: { playbook: string }) =>
      a.playbook.localeCompare(b.playbook);
    expect(floating.sort(byPlaybook)).toEqual(
      (table.hashes() as { playbook: string; package: string }[]).sort(
        byPlaybook
      )
    );
  }
);

const commands = (world: RulesWorld): Located[] =>
  world.tasks.filter(
    ({ task }) => moduleOf(task) === 'ansible.builtin.command'
  );
const named = ({ path, task }: Located): string =>
  `${path}: ${String(task['name'])}`;

Then(
  'every command task sets {string} or {string}',
  (world, keyword: string, argument: string) => {
    expect(commands(world).length).toBeGreaterThan(0);
    const silent = commands(world).filter(({ task }) => {
      const command = task['ansible.builtin.command'];
      return (
        !(keyword in task) &&
        !(typeof command === 'object' && command && argument in command)
      );
    });
    expect(silent.map(named)).toEqual([]);
  }
);

Then(
  'every command task that changes nothing sets {string} to false or is skipped when {string}',
  (world, keyword: string, variable: string) => {
    const reads = commands(world).filter(
      ({ task }) => task['changed_when'] === false
    );
    expect(reads.length).toBeGreaterThan(0);
    const unanswered = reads.filter(
      ({ task }) =>
        task[keyword] !== false &&
        !String(task['when'] ?? '').includes(variable)
    );
    expect(unanswered.map(named)).toEqual([]);
  }
);

const downloads = (world: RulesWorld): Task[] =>
  world.tasks.flatMap(({ task }) =>
    task['ansible.builtin.get_url']
      ? [task['ansible.builtin.get_url'] as Task]
      : []
  );

Then('at least one task downloads a file', (world) => {
  expect(downloads(world).length).toBeGreaterThan(0);
});

Then('every download carries a {string} checksum', (world, kind: string) => {
  for (const download of downloads(world))
    expect(String(download['checksum'])).toStartWith(`${kind}:`);
});

function conditions(value: unknown, found: unknown[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) conditions(item, found);
    return;
  }
  const object = value as Record<string, unknown>;
  const assertion = object['ansible.builtin.assert'];
  if (assertion && typeof assertion === 'object') {
    const that = (assertion as Record<string, unknown>)['that'];
    const items = Array.isArray(that) ? that : [that];
    if (!items.length || !items.every((item) => typeof item === 'string'))
      throw new Error(
        'Ansible assertion conditions must be strings; quote YAML expressions containing colon-space.'
      );
    found.push(...items);
  }
  for (const item of Object.values(object)) conditions(item, found);
}

When('every assertion of every playbook is read', async (world) => {
  for (const path of await playbooks())
    conditions(parse(read(path)), world.conditions);
});

Then('every condition is a string', (world) => {
  expect(world.conditions.length).toBeGreaterThan(10);
  for (const condition of world.conditions) expect(condition).toBeString();
});

Given('a playbook that asserts:', (world, yaml: string) => {
  world.script = yaml;
});

When('its assertions are read', (world) => {
  try {
    conditions(parse(world.script), world.conditions);
  } catch (error) {
    world.failure = error as Error;
  }
});

Then('reading them fails with {string}', (world, message: string) => {
  expect(world.failure?.message).toContain(message);
});

When('every ownership marker a playbook compares is read', async (world) => {
  for (const path of await playbooks())
    for (const line of read(path).split('\n'))
      if (/^\s*-\s*"/.test(line) && line.includes('Managed by personal'))
        world.found.push(line);
});

Then('no marker is followed by a path', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
  // No path after the marker's colon: not a directory, package or repository.
  for (const line of world.found)
    expect(line).not.toMatch(/Managed by personal [A-Za-z-]+:[^'"]*\//);
});

// ── TypeScript ───────────────────────────────────────────────────────────

const VERB = `['"\`](?:start|restart|enable|disable|reload)['"\`]`;
const IMPERATIVE: RegExp[] = [
  // The command and one of its changing verbs anywhere in the same file: a
  // wrapper that takes the verb as an argument counts too.
  new RegExp(`systemctl[\\s\\S]*${VERB}|${VERB}[\\s\\S]*systemctl`),
  /launchctl[\s\S]*'(bootstrap|bootout|kickstart)'/,
  /'serve',\s*'--bg'/,
  /'(apt|apt-get|dpkg)',\s*'(install|remove|purge|-i)'/,
  /'npm',\s*'(install|i)'/,
  /'brew',/,
  /'pmset',\s*'-[abc]'/,
  /'defaults',\s*'write'/,
  /'loginctl',\s*'enable-linger'/,
];

When(
  'the TypeScript sources are searched for commands that change a machine',
  async (world) => {
    const sources = [
      ...(await files('src/**/*.ts')),
      ...(await files('agents/*.ts')),
      ...(await files('bootstrap/*.ts')),
    ].filter((path) => !path.endsWith('.test.ts'));
    world.searched = sources.length;
    world.found = sources.filter((path) =>
      IMPERATIVE.some((pattern) => pattern.test(read(path)))
    );
  }
);

Then('more than {int} source files were searched', (world, count: number) => {
  expect(world.searched).toBeGreaterThan(count);
});

Then('only these files run such a command:', (world, table: DataTable) => {
  expect(world.found).toEqual(table.list().sort());
});

// ── Pins ─────────────────────────────────────────────────────────────────

const pin = (name: string): string | undefined =>
  new RegExp(`^${name} = "(.*)"$`, 'm').exec(read('mise.toml'))?.[1];
const RELEASE = /\d{4}\.\d+\.\d+/;

Then('mise.toml pins the version of mise as a release number', () => {
  expect(pin('min_version')).toMatch(new RegExp(`^${RELEASE.source}$`));
});

Then(
  'mise.toml holds a SHA-256 digest named {string}',
  (_world, name: string) => {
    expect(pin(name)).toMatch(/^[a-f0-9]{64}$/);
  }
);

Then('{string} contains {string}', (_world, path: string, text: string) => {
  expect(read(path)).toContain(text);
});

Then(
  '{string} does not contain {string}',
  (_world, path: string, text: string) => {
    expect(read(path)).not.toContain(text);
  }
);

Then('{string} names no mise release number', (_world, path: string) => {
  expect(read(path)).not.toMatch(RELEASE);
});

Then(
  '{string} sets $MiseVersion to the mise version mise.toml pins',
  (_world, path: string) => {
    expect(/^\$MiseVersion = '(.*)'$/m.exec(read(path))?.[1]).toBe(
      pin('min_version')!
    );
  }
);

Then('{string} requires one exact Python version', (_world, path: string) => {
  expect(read(path)).toMatch(/^requires-python = "==\d+\.\d+\.\d+"$/m);
});

Then(
  '{string} depends on one exact ansible-core version',
  (world, path: string) => {
    world.ansibleCore =
      /"ansible-core==(\d+\.\d+\.\d+)"/.exec(read(path))?.[1] ?? '';
    expect(world.ansibleCore).not.toBe('');
  }
);

Then('{string} locks that ansible-core version', (world, path: string) => {
  expect(read(path)).toContain(
    `name = "ansible-core"\nversion = "${world.ansibleCore}"`
  );
});

Then('{string} records SHA-256 hashes', (_world, path: string) => {
  expect(read(path)).toMatch(/hash = "sha256:[a-f0-9]{64}"/);
});

Then(
  'the {string} service in {string} runs the image {string} of the Beszel lock',
  (_world, service: string, path: string, key: 'image' | 'tunnelImage') => {
    const compose = parse(read(path)) as {
      services: Record<string, { image: string }>;
    };
    expect(compose.services[service]!.image).toBe(beszel[key]);
  }
);

Then(
  'the hub image of the Beszel lock is the locked version, pinned by digest',
  () => {
    expect(beszel.image).toContain(`:${beszel.version}@sha256:`);
  }
);

Then(
  'the agent unit starts the agent from the directory of the locked version',
  () => {
    // The unit file is copied as it is, so it carries the path itself.
    expect(read('ansible/monitoring/beszel-agent.service')).toContain(
      `ExecStart=/usr/local/lib/personal-beszel/${beszel.version}/beszel-agent`
    );
  }
);

Then(
  'none of these files names the locked Beszel version:',
  (_world, table: DataTable) => {
    for (const path of table.list())
      expect(read(path)).not.toContain(beszel.version);
  }
);

When('the packages {string} installs are read', (world, path: string) => {
  world.found = (/^\s*for package in (.+); do$/m.exec(read(path))?.[1] ?? '')
    .split(' ')
    .filter(Boolean);
});

Then('each is a package the Ubuntu policy pins', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
  for (const name of world.found)
    expect(Object.keys(ubuntu.packages)).toContain(name);
});

/** A release of the Ubuntu policy as a word, never inside a package version
 * such as 12.12ubuntu2.26.04.2; its codename as a word. */
const RELEASE_NAMES = new RegExp(
  ubuntu.releases
    .flatMap((entry) => [
      `(?<![\\w.])${entry.release.replace('.', '\\.')}(?!\\.?\\d)`,
      `\\b${entry.codename}\\b`,
    ])
    .join('|')
);

When(
  'the files under these directories are searched for a release or codename the Ubuntu policy accepts:',
  async (world, table: DataTable) => {
    const paths = (
      await Promise.all(table.list().map((dir) => files(`${dir}/**/*`)))
    ).flat();
    world.searched = paths.length;
    world.found = paths.filter((path) => RELEASE_NAMES.test(read(path)));
  }
);

Then('only these files name one:', (world, table: DataTable) => {
  expect(world.searched).toBeGreaterThan(0);
  expect(world.found).toEqual(table.list().sort());
});

When(
  'this text is searched for a release or codename the Ubuntu policy accepts:',
  (world, text: string) => {
    world.found = RELEASE_NAMES.test(text) ? [text] : [];
  }
);

Then(/^it names (one|none)$/, (world, verdict: string) => {
  expect(world.found.length).toBe(verdict === 'one' ? 1 : 0);
});

When('the release entries of the Ubuntu policy are read', (world) => {
  world.searched = ubuntu.releases.length;
});

const releaseEntries = (): {
  packages?: Record<string, string>;
  browserPackages?: Record<string, string>;
}[] => ubuntu.releases;

Then('each pins only packages the policy\'s "packages" pins', (world) => {
  expect(world.searched).toBeGreaterThan(0);
  for (const entry of releaseEntries())
    for (const name of Object.keys(entry.packages ?? {}))
      expect(Object.keys(ubuntu.packages)).toContain(name);
});

Then(
  'each pins only browser libraries the policy\'s "browser.packages" pins',
  () => {
    for (const entry of releaseEntries())
      for (const name of Object.keys(entry.browserPackages ?? {}))
        expect(Object.keys(ubuntu.browser.packages)).toContain(name);
  }
);

When(
  'every key of the macOS and Ubuntu policies is looked up in the playbooks, the sources and these features',
  async (world) => {
    const readers = [
      ...(await files('ansible/**/*.yml')),
      ...(await files('src/**/*.ts')).filter(
        (path) => !path.endsWith('.test.ts')
      ),
      'features/rules/steps.ts',
    ]
      .map(read)
      .join('\n');
    world.found = [
      ...Object.keys(macos).map((key) => `macos.${key}`),
      ...Object.keys(ubuntu).map((key) => `ubuntu.${key}`),
      ...Object.keys(ubuntu.resourceSafety).map((key) => `ubuntu.${key}`),
    ].filter(
      (name) => !new RegExp(`\\b${name.split('.')[1]!}\\b`).test(readers)
    );
  }
);

Then('every key is read somewhere', (world) => {
  expect(world.found).toEqual([]);
});

Then(
  'package.json names the Bun version mise.toml pins as its package manager',
  () => {
    expect(read('package.json')).toContain(
      `"packageManager": "bun@${pin('bun')}"`
    );
  }
);

// ── Workflows ────────────────────────────────────────────────────────────

async function workflow(name: string): Promise<Workflow> {
  for (const path of await files('.github/workflows/*.yml')) {
    const parsed = parse(read(path)) as Workflow;
    if (parsed.name === name) return parsed;
  }
  throw new Error(`No workflow is named ${name}.`);
}
const job = (world: RulesWorld, name: string) => world.workflow!.jobs[name]!;
/** Every `"quoted"` value of a list written in a step. */
const quotedList = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
const jobEnv = (world: RulesWorld, name: string): Record<string, string> =>
  Object.assign(
    {},
    ...(job(world, name).steps ?? []).map((step) => step.env ?? {})
  );

When(
  'the steps of the {string} workflow that install mise are read',
  async (world, name: string) => {
    world.workflowSteps = Object.values((await workflow(name)).jobs)
      .flatMap((entry) => entry.steps ?? [])
      .filter(
        (step) =>
          step.uses?.startsWith('jdx/mise-action@') ||
          step.uses === './.github/actions/mise'
      );
    world.found = world.workflowSteps.map((step) => String(step.uses));
  }
);

Then('each installs mise through {string}', (world, action: string) => {
  for (const step of world.workflowSteps) expect(step.uses).toBe(`./${action}`);
});

Then(
  '{string} installs the mise version it reads from mise.toml',
  (_world, path: string) => {
    const action = parse(read(path)) as {
      runs: { steps: (WorkflowStep & { id?: string })[] };
    };
    const reader = action.runs.steps.find((step) =>
      step.run?.includes('min_version')
    );
    expect(reader?.run).toContain('mise.toml');
    const installer = action.runs.steps.find((step) =>
      step.uses?.startsWith('jdx/mise-action@')
    );
    expect(installer?.with?.['version']).toBe(
      `\${{ steps.${reader?.id}.outputs.version }}`
    );
  }
);

Then('no workflow names a mise release number', async () => {
  for (const path of await files('.github/**/*.yml'))
    expect(`${path}: ${read(path)}`).not.toContain(pin('min_version')!);
});

Then('there is at least one', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
});

Then('each names the tools it installs', (world) => {
  // Named tools only: never the whole workstation toolchain.
  for (const step of world.workflowSteps)
    expect(step.with?.['install_args']).toBeString();
});

When('the actions {string} uses are read', (world, path: string) => {
  world.found = [...read(path).matchAll(/^\s*-?\s*uses: (.+)$/gm)].map(
    (match) => match[1]!
  );
});

Then(
  'each is pinned to a full commit, with its release in a comment',
  (world) => {
    // An action of this repository runs at the commit under test.
    for (const action of world.found.filter((uses) => !uses.startsWith('./')))
      expect(action).toMatch(
        /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[a-f0-9]{40} # v\d+\.\d+\.\d+$/
      );
  }
);

When(
  'the service images of the {string} workflow are read',
  async (world, name: string) => {
    world.found = Object.values((await workflow(name)).jobs).flatMap((entry) =>
      Object.values(entry.services ?? {}).map((service) => service.image)
    );
  }
);

Then('each is pinned by tag and SHA-256 digest', (world) => {
  for (const image of world.found)
    expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
});

Then(
  'the {string} workflow runs on {string}',
  async (world, name: string, event: string) => {
    world.workflow = await workflow(name);
    expect(Object.keys(world.workflow.on)).toContain(event);
  }
);

Then('its {string} job has no condition', (world, name: string) => {
  expect(job(world, name).if).toBeUndefined();
});

Then(
  'its {string} job sets {string} to {string}',
  (world, name: string, variable: string, value: string) => {
    expect(jobEnv(world, name)[variable]).toBe(value);
  }
);

Then(
  'its {string} job points {string} at a local S3 service',
  (world, name: string, variable: string) => {
    expect(jobEnv(world, name)[variable]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/
    );
  }
);

Then(
  'its {string} job runs {string}',
  (world, name: string, command: string) => {
    expect(
      (job(world, name).steps ?? []).some((step) => step.run?.includes(command))
    ).toBe(true);
  }
);

Then(
  'its {string} job runs on {string}',
  (world, name: string, runner: string) => {
    expect(job(world, name)['runs-on']).toBe(runner);
  }
);

Then(
  /^the "([^"]+)" workflow's "([^"]+)" job needs (.+)$/,
  async (world, name: string, needing: string, needed: string) => {
    world.workflow = await workflow(name);
    expect([job(world, needing).needs ?? []].flat().sort()).toEqual(
      quotedList(needed).sort()
    );
  }
);

Then(
  'its {string} job calls {string} for the commit {string} packed',
  (world, name: string, path: string, packer: string) => {
    expect(job(world, name).uses).toBe(`./${path}`);
    expect(job(world, name).with?.['ref']).toBe(
      `\${{ needs.${packer}.outputs.commit }}`
    );
  }
);

Then(
  '{string} requires the profile {string}',
  (_world, path: string, profile: string) => {
    expect((parse(read(path)) as { profile?: string }).profile).toBe(profile);
  }
);

When(
  'the {string} step of the {string} workflow is read',
  async (world, step: string, name: string) => {
    world.script =
      Object.values((await workflow(name)).jobs)
        .flatMap((entry) => entry.steps ?? [])
        .find((candidate) => candidate.name === step)?.run ?? '';
  }
);

Then(
  'it runs {string} before {string}',
  (world, first: string, second: string) => {
    const at = world.script.indexOf(first);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(world.script.indexOf(second));
  }
);

// ── Pull requests ────────────────────────────────────────────────────────

Then(
  'every other job of the {string} workflow is needed by its {string} job',
  async (world, name: string, needing: string) => {
    world.workflow = await workflow(name);
    expect([job(world, needing).needs ?? []].flat().sort()).toEqual(
      Object.keys(world.workflow.jobs)
        .filter((other) => other !== needing)
        .sort()
    );
  }
);

Then('its {string} job runs whatever became of them', (world, name: string) => {
  expect(job(world, name).if).toBe('always()');
});

Then(
  'the {string} workflow cancels a run in progress only for {string}',
  async (_world, name: string, event: string) => {
    expect((await workflow(name)).concurrency?.['cancel-in-progress']).toBe(
      `\${{ github.event_name == '${event}' }}`
    );
  }
);

Then(
  'the {string} workflow runs on {string} only when one is:',
  async (_world, name: string, event: string, table: DataTable) => {
    expect((await workflow(name)).on[event]?.types).toEqual(table.list());
  }
);

Then(
  'the {string} workflow follows the {string} workflow',
  async (_world, name: string, followed: string) => {
    expect((await workflow(name)).on['workflow_run']?.workflows).toContain(
      followed
    );
  }
);

When(
  'the workflows that run in this repository by themselves are listed',
  async (world) => {
    // A workflow only another repository calls reports there.
    world.found = (await files('.github/workflows/*.yml'))
      .map((path) => parse(read(path)) as Workflow)
      .filter((entry) =>
        Object.keys(entry.on).some((event) => event !== 'workflow_call')
      )
      .map((entry) => entry.name);
  }
);

Then(
  'each is followed by the {string} workflow',
  async (world, name: string) => {
    const followed = (await workflow(name)).on['workflow_run']?.workflows ?? [];
    expect(world.found.filter((entry) => entry !== name).sort()).toEqual(
      [...followed].sort()
    );
  }
);

Then(
  'on the hour its {string} job reads every workflow it follows',
  (world, name: string) => {
    // The matrix is the workflow that ended, or else this literal list.
    const matrix = String(job(world, name).strategy?.matrix?.['workflow']);
    const hourly = /fromJSON\('(\[[^']*\])'\)\s*\}\}$/.exec(matrix)?.[1];
    expect(JSON.parse(hourly ?? '[]')).toEqual(
      world.workflow?.on['workflow_run']?.workflows
    );
  }
);

Then(
  'the {string} workflow follows no run of a pull request',
  async (_world, name: string) => {
    for (const entry of Object.values((await workflow(name)).jobs))
      expect(entry.if).toContain(
        "github.event.workflow_run.event != 'pull_request'"
      );
  }
);

Then(
  'its {string} job keeps {string} when it fails',
  (world, name: string, path: string) => {
    const keeper = (job(world, name).steps ?? []).find((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    );
    expect(keeper?.if).toBe('failure()');
    expect(String(keeper?.with?.['path'])).toContain(path);
  }
);

// ── Convergence ──────────────────────────────────────────────────────────

/** Tooling that runs on the developer's machine or in CI, never a fleet machine's. */
const NOT_CONVERGENCE = [
  'bootstrap/npm.ts',
  'bootstrap/release-version.ts',
  'bootstrap/release-notes.ts',
  'bootstrap/package-smoke.ts',
  'bootstrap/pins.ts',
  'bootstrap/doctor.ts',
  'bootstrap/setup-status.ts',
  'bootstrap/devfleet',
  'bootstrap/fleet-manager-run.sh',
  'bootstrap/verify-t3-archive.py',
  'bootstrap/bootstrap.ps1',
];

When('the bootstrap scripts and modules are listed', async (world) => {
  world.found = (await files('bootstrap/*')).filter(
    (path) => !NOT_CONVERGENCE.includes(path)
  );
});

When('every playbook is listed', async (world) => {
  world.found = await playbooks();
  world.found = world.found.filter((path) => !path.includes('/tasks/'));
});

Then(
  'each file found is named in {string} with a reason',
  (world, path: string) => {
    expect(world.found.length).toBeGreaterThan(0);
    const rows = read(path).split('\n');
    const missing = world.found.filter(
      (file) =>
        !rows.some(
          (row) =>
            row.includes(`\`${file}\``) &&
            (row.split('|').at(-2)?.trim().length ?? 0) > 20
        )
    );
    expect(missing).toEqual([]);
  }
);

Then('each file found is named in {string}', (world, path: string) => {
  expect(world.found.length).toBeGreaterThan(0);
  const text = read(path);
  expect(world.found.filter((file) => !text.includes(`\`${file}\``))).toEqual(
    []
  );
});

// ── Keeping pins current ─────────────────────────────────────────────────

Then(
  'a custom manager of Renovate reads the tag and digest of {string} in {string}',
  (_world, key: string, path: string) => {
    const { customManagers = [] } = JSON.parse(read('renovate.json')) as {
      customManagers?: {
        managerFilePatterns: string[];
        matchStrings: string[];
      }[];
    };
    const text = read(path);
    const pattern = (written: string) =>
      new RegExp(written.replace(/^\/(.*)\/$/, '$1'));
    const captured = customManagers
      .filter((manager) =>
        manager.managerFilePatterns.some((files) => pattern(files).test(path))
      )
      .flatMap((manager) => manager.matchStrings)
      .map((match) => new RegExp(match).exec(text)?.groups)
      .find(
        (groups) => groups && text.includes(`"${key}": "${groups['depName']}:`)
      );
    expect(captured?.['currentValue']).toBeString();
    expect(captured?.['currentDigest']).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
);

Then(
  /^docs\/declared\.md says "([^"]+)" is moved by a person, and why$/,
  (_world, pin: string) => {
    const section = read('docs/declared.md').split(
      '## Keeping pins current'
    )[1]!;
    const row = section
      .split('\n')
      .find((line) => line.startsWith(`| ${pin} `));
    expect(row).toMatch(/\| A person, because .{20,}\|$/);
  }
);

// ── Identity ─────────────────────────────────────────────────────────────

const SKIPPED =
  /^(cliproxy\/vendor\/|\.mise\/|bun\.lock$|mise\.lock$)|\.(png|svg)$/;

async function tracked(): Promise<[string, string][]> {
  const paths = (await Bun.$`git -C ${root} ls-files`.text()).split('\n');
  return (
    paths
      // A file deleted in the working tree is still listed until it is committed.
      .filter(
        (path) => path && !SKIPPED.test(path) && existsSync(resolve(root, path))
      )
      .map((path) => [path, read(path)])
  );
}

const KINDS: Record<string, RegExp> = {
  'email addresses': /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  'tailnet names': /\b[a-z0-9-]+\.ts\.net\b/g,
  'home directories': /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g,
};

When(
  /^every tracked text file is searched for (email addresses|tailnet names|home directories)$/,
  async (world, kind: string) => {
    const found = new Set<string>();
    for (const [path, text] of await tracked())
      for (const match of text.match(KINDS[kind]!) ?? [])
        found.add(`${path}: ${match}`);
    world.found = [...found].sort();
    world.searched = found.size;
  }
);

const value = (entry: string): string => entry.slice(entry.indexOf(': ') + 2);

Then(
  'each one found is a tool version such as {string}, or is at one of these placeholder domains:',
  (world, _example: string, table: DataTable) => {
    expect(world.searched).toBeGreaterThan(0);
    const domains = table.list();
    const real = world.found.filter((entry) => {
      const domain = value(entry).split('@')[1]!;
      return !domains.includes(domain) && !/^(\d[\d.]*|X\.Y\.Z)$/.test(domain);
    });
    expect(real).toEqual([]);
  }
);

Then(
  'each one found is one of these placeholders:',
  (world, table: DataTable) => {
    expect(world.searched).toBeGreaterThan(0);
    const allowed = table.list();
    expect(
      world.found.filter((entry) => !allowed.includes(value(entry)))
    ).toEqual([]);
  }
);

Then(
  'each one found belongs to one of these placeholder users:',
  (world, table: DataTable) => {
    expect(world.searched).toBeGreaterThan(0);
    const users = table.list();
    expect(
      world.found.filter(
        (entry) => !users.includes(value(entry).split('/').at(-1)!)
      )
    ).toEqual([]);
  }
);

When(
  'every tracked text file is searched for the names in DEVFLEET_FORBIDDEN',
  async (world) => {
    const names = (process.env['DEVFLEET_FORBIDDEN'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    for (const [path, text] of await tracked())
      for (const name of names)
        if (text.toLowerCase().includes(name))
          world.found.push(`${path}: ${name}`);
  }
);

Then('none is found', (world) => {
  expect(world.found).toEqual([]);
});

// ── Package ──────────────────────────────────────────────────────────────

When('the package is packed', async (world) => {
  const out = await Bun.$`npm pack --dry-run --json --ignore-scripts`
    .cwd(root)
    .quiet()
    .text();
  world.packed = (
    JSON.parse(out) as { files: { path: string }[] }[]
  )[0]!.files.map((file) => file.path);
});

Then('it contains:', (world, table: DataTable) => {
  for (const path of table.list()) expect(world.packed).toContain(path);
});

Then(
  "the file the manager's schedule runs, once the package is installed, is one it contains",
  (world) => {
    const published = {
      ...release(root),
      version: '1.2.3',
      revision: 'a'.repeat(40),
    };
    expect(publishedRelease(published)).toBe(true);
    const prefix = '/runtime';
    const command = scheduledCommand(published, 'a'.repeat(40), prefix);
    const installed = `${prefix}/node_modules/${String(manifest()['name'])}/`;
    const entry = command.find((part) => part.startsWith(installed));
    expect(entry).toBeDefined();
    expect(world.packed).toContain(entry!.slice(installed.length));
  }
);

const manifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

Then(
  'the package manifest declares the command {string}',
  (_world, name: string) => {
    expect(Object.keys(manifest()['bin'] as object)).toEqual([name]);
  }
);

Then(
  'the package manifest declares none of these fields:',
  (_world, table: DataTable) => {
    for (const field of table.list())
      expect(manifest()).not.toHaveProperty(field);
  }
);

Then('it contains no test file, no test directory and no feature', (world) => {
  expect(
    world.packed.filter((path) =>
      /\.test\.ts$|(^|\/)tests\/|(^|\/)features\/|\.feature$/.test(path)
    )
  ).toEqual([]);
});

When('{string} is run in the checkout', async (world, command: string) => {
  world.output = await Bun.$`${{ raw: command }}`.cwd(root).quiet().text();
});

Then('it prints {string}', (world, text: string) => {
  expect(world.output.trim()).toBe(text);
});

Then(
  'its {string} job runs once for each of:',
  (world, name: string, table: DataTable) => {
    const matrix = job(world, name).strategy?.matrix;
    const [key] = table.raw()[0] ?? [];
    // A matrix of one list says the same as an include of one key.
    const rows =
      matrix?.include ??
      (matrix?.[key!] as unknown[] | undefined)?.map((value) => ({
        [key!]: String(value),
      }));
    expect(rows).toEqual(table.hashes());
  }
);

Then(
  'its {string} job runs every feature of {string}',
  async (world, name: string, directory: string) => {
    const rows = job(world, name).strategy?.matrix?.include ?? [];
    expect(
      [
        ...new Set(rows.map((row) => `${directory}/${row['feature']}.feature`)),
      ].sort()
    ).toEqual((await files(`${directory}/*.feature`)).sort());
  }
);

Then(
  'its {string} job runs every release the Ubuntu policy accepts',
  (world, name: string) => {
    const rows = (job(world, name).strategy?.matrix?.include ?? []) as {
      release?: unknown;
    }[];
    expect([...new Set(rows.map((row) => String(row.release)))].sort()).toEqual(
      ubuntu.releases.map((entry) => entry.release).sort()
    );
  }
);

// ── The features themselves ──────────────────────────────────────────────

When(
  'the TypeScript test files in the repository are listed',
  async (world) => {
    world.found = (await files('**/*.test.ts')).filter(
      (path) => !path.startsWith('node_modules/') && !path.includes('/vendor/')
    );
  }
);

Then(
  'each is the {string} of a directory under {string}',
  (world, name: string, directory: string) => {
    for (const path of world.found)
      expect(path).toMatch(new RegExp(`^${directory}/[a-z-]+/${name}$`));
  }
);

When(
  'the areas under {string} are listed',
  async (world, directory: string) => {
    world.found = [
      ...new Set(
        (await files(`${directory}/*/*.feature`)).map((path) =>
          path.split('/').slice(0, 2).join('/')
        )
      ),
    ];
  }
);

Then(
  'each holds at least one {string} file',
  async (world, extension: string) => {
    for (const area of world.found)
      expect((await files(`${area}/**/*${extension}`)).length).toBeGreaterThan(
        0
      );
  }
);

Then('each holds a {string}', (world, name: string) => {
  for (const area of world.found)
    expect(existsSync(resolve(root, area, name))).toBe(true);
});

When('every scenario of every feature is read', async (world) => {
  world.scenarios = [];
  for (const path of await files('features/**/*.feature'))
    for (const scenario of scenariosOf(read(path)))
      world.scenarios.push({ path, ...scenario });
});

Then('there are more than {int} scenarios', (world, count: number) => {
  expect(world.scenarios.length).toBeGreaterThan(count);
});

Then('none has more than one {string} step', (world, keyword: string) => {
  expect(
    world.scenarios
      .filter((scenario) => (scenario.keywords[keyword] ?? 0) > 1)
      .map((scenario) => `${scenario.path}: ${scenario.name}`)
  ).toEqual([]);
});

// ── Emitters ─────────────────────────────────────────────────────────────

/** Source files that produce checks and codes: TypeScript and what Ansible
 * runs on a machine. */
async function emitters(): Promise<{ path: string; text: string }[]> {
  const paths = [
    ...(await files('src/**/*.ts')),
    ...(await files('bootstrap/**/*.ts')),
    ...(await files('ansible/**/*.{yml,sh,py}')),
  ];
  return paths.map((path) => ({ path, text: read(path) }));
}

When(
  'the check ids of the {string} and {string} columns of the fleet-sync report are read',
  (world, first: string, second: string) => {
    const report = read('src/cli/fleet-sync-output.ts');
    world.found = [first, second].flatMap((title) => {
      const column = new RegExp(
        `title: '${title}',[\\s\\S]*?\\]\\.includes\\(`
      ).exec(report)?.[0];
      if (!column) throw new Error(`No column ${title}.`);
      return [...column.matchAll(/'([a-z0-9]+:[a-z0-9:-]+)'/g)].map(
        (match) => match[1]!
      );
    });
  }
);

Then('there are more than {int}', (world, count: number) => {
  expect(world.found.length).toBeGreaterThan(count);
});

Then('each is produced outside the report', async (world) => {
  const sources = (await emitters()).filter(
    ({ path }) => path !== 'src/cli/fleet-sync-output.ts'
  );
  // `worker:` checks are built from their name by one helper.
  const produced = (id: string) =>
    [id, id.slice(id.indexOf(':') + 1)].some((name) =>
      sources.some(({ text }) => text.includes(`'${name}'`))
    );
  expect(world.found.filter((id) => !produced(id))).toEqual([]);
});

When('the T3 codes the documents and features name are read', async (world) => {
  const documents = [
    'README.md',
    ...(await files('docs/**/*.md')),
    ...(await files('features/**/*.feature')),
  ];
  world.found = [
    ...new Set(
      documents.flatMap((path) =>
        [...read(path).matchAll(/(?<![$\w])T3_[A-Z]+(?:_[A-Z]+)+\b/g)].map(
          (match) => match[0]
        )
      )
    ),
  ];
});

Then(
  'each is emitted by the code that measures or recovers T3',
  async (world) => {
    const sources = await emitters();
    expect(
      world.found.filter(
        (code) =>
          !sources.some(({ text }) => new RegExp(`\\b${code}\\b`).test(text))
      )
    ).toEqual([]);
  }
);

// ── Runbooks ─────────────────────────────────────────────────────────────

/** The last word of a failure code: what went wrong. */
const FAILURE =
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:FAILED|FAILING|REQUIRED|MISSING|MISMATCH|CONFLICT|UNVERIFIED|UNAVAILABLE|UNREACHABLE|INVALID|REJECTED|INCOMPLETE|STALE|DRIFT|PENDING|DENIED|TIMEOUT|FULL|UNSUPPORTED|LOCKED|OFFLINE|UNSCHEDULED|UNDECLARED|OVERRIDDEN|REFUSED|UNHEALTHY|BROKEN|CONTENDED|INTERRUPTED|UNSAFE|DIVERGED|BLOCKED|STOPPED|EXHAUSTED|INACTIVE|CHANGED|UNREADABLE|LIMIT|LIMITED|UNSERVED|UNOBSERVED|UNPROVISIONED|REPLACED|INSTALLED|RUNNING|ENABLED|POLICY|BUSY|FLOOR|ENROLLED|DISCONNECTED|PROTOCOL|DAEMON|RESPONSE|UNRESTRICTED|PREVIEW|ERROR|ROLE|HUB|MANAGER|CONVERGED|POWER|MINIMUM)$/;

async function failureCodes(): Promise<string[]> {
  const codes = new Set<string>();
  const sources: [string, RegExp][] = [
    ['src/**/*.ts', /['"`]([A-Z][A-Z0-9_]+)['"`]/g],
    ['bootstrap/*.ts', /['"`]([A-Z][A-Z0-9_]+)['"`]/g],
    ['bootstrap/*.sh', /\bdie ([A-Z][A-Z0-9_]+)/g],
    ['ansible/**/*.sh', /\bdie ([A-Z][A-Z0-9_]+)/g],
    ['ansible/**/*.yml', /(?:fail_msg:\s*['"]?|\()([A-Z][A-Z0-9_]+)[;)]/g],
  ];
  for (const [pattern, code] of sources)
    for (const path of await files(pattern))
      for (const match of read(path).matchAll(code))
        if (FAILURE.test(match[1]!)) codes.add(match[1]!);
  return [...codes].sort();
}

const entries = (path: string): string[] =>
  [...read(path).matchAll(/^- `([A-Z][A-Z0-9_]+)`:/gm)].map(
    (match) => match[1]!
  );

When('the failure codes of the source are collected', async (world) => {
  world.found = await failureCodes();
});

Then('there are more than {int} of them', (world, count: number) => {
  expect(world.found.length).toBeGreaterThan(count);
});

Then('each has an entry in {string}', (world, path: string) => {
  const listed = new Set(entries(path));
  expect(world.found.filter((code) => !listed.has(code))).toEqual([]);
});

Then(
  '{string} has no entry for a code the source does not report',
  (world, path: string) => {
    const reported = new Set(world.found);
    expect(entries(path).filter((code) => !reported.has(code))).toEqual([]);
  }
);

Then(
  '{string} states how many codes there are and how many need a person',
  (world, path: string) => {
    const text = read(path);
    const person = text
      .split('\n')
      .filter(
        (line) => /^- `[A-Z]/.test(line) && line.includes('**Needs a person.**')
      );
    expect(text).toContain(
      `There are ${world.found.length} codes; ${person.length} need a person.`
    );
  }
);

/** The documents an operator follows. */
async function documents(): Promise<string[]> {
  return [...(await files('docs/*.md')), 'README.md', 'llms.txt'];
}

/** Only what is quoted as code: a span or a fenced block. */
function quoted(text: string): string[] {
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(
    (match) => match[1]!
  );
  const prose = text.replace(/```[a-z]*\n[\s\S]*?```/g, '');
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...blocks, ...spans];
}

When(
  'the devfleet commands quoted in the documents are read',
  async (world) => {
    world.found = [];
    for (const path of await documents())
      for (const code of quoted(read(path)))
        for (const match of code.matchAll(/\bdevfleet ([a-z][a-z0-9-]*)/g))
          world.found.push(`${path}: ${match[1]!}`);
  }
);

Then('each is a command of the devfleet CLI', async (world) => {
  const { COMMANDS } = await import('../../src/cli/registry');
  const known = new Set(COMMANDS.map((command) => command.args[0]));
  expect(
    world.found.filter((entry) => !known.has(entry.split(': ')[1]!))
  ).toEqual([]);
});

When(
  'the documents are searched for an earlier executable or package',
  async (world) => {
    world.found = [];
    for (const path of await documents())
      for (const code of quoted(read(path)))
        if (/(^|\s)personal [a-z]|@pkgs\/|packages\/fleet/m.test(code))
          world.found.push(`${path}: ${code.split('\n')[0]}`);
  }
);

Then('nothing is found', (world) => {
  expect(world.found).toEqual([]);
});

// ── Generated tables of the authentication document ──────────────────────

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length))
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')} |`;
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

const GENERATED: Record<string, () => Promise<string>> = {
  secrets: async () => {
    const { SECRET_NAMES, OPTIONAL_SECRET_NAMES, envName } =
      await import('../../src/secrets');
    const rows = [
      ...SECRET_NAMES.map((name) => [name, 'yes']),
      ...OPTIONAL_SECRET_NAMES.map((name) => [
        name,
        'when its feature is declared',
      ]),
    ].map(([name, required]) => [
      `\`${name}\``,
      required!,
      `\`${envName(name as never)}\``,
      `\`~/.config/dev-fleet/secrets/${name}\``,
    ]);
    return table(
      ['Secret', 'Required', '`env` provider variable', '`file` provider file'],
      rows
    );
  },
  checks: async () => {
    const found = new Map<string, Set<string>>();
    // The owners of the checks name them; they measure nothing.
    for (const path of (await files('src/**/*.ts')).filter(
      (path) =>
        path !== 'src/check-owners.ts' && path !== 'src/check-registry.ts'
    ))
      for (const match of read(path).matchAll(
        /['`]((?:auth|worker):[a-z0-9-]*(?:auth|github|vault|git-|credential)[a-z0-9-]*)['`]/g
      )) {
        const paths = found.get(match[1]!) ?? new Set<string>();
        paths.add(`\`${path}\``);
        found.set(match[1]!, paths);
      }
    return table(
      ['Check', 'Measured in'],
      [...found]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, paths]) => [`\`${id}\``, [...paths].sort().join(', ')])
    );
  },
  timers: async () => {
    const rows: string[][] = [];
    for (const path of await files('ansible/**/*.yml'))
      for (const match of read(path).matchAll(
        /(personal-[a-z0-9-]+\.timer)'?\n[\s\S]*?\[Timer\]\n([\s\S]*?)\[Install\]/g
      ))
        rows.push([
          `\`${match[1]!}\``,
          `\`${path}\``,
          match[2]!
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^On[A-Za-z]+=/.test(line))
            .join(', '),
        ]);
    return table(
      ['Timer', 'Declared in', 'Schedule'],
      rows.sort((a, b) => a[0]!.localeCompare(b[0]!))
    );
  },
};

const generatedTables = new WeakMap<RulesWorld, string>();

When(
  'the table {string} is generated from the code',
  async (world, name: string) => {
    generatedTables.set(world, await GENERATED[name]!());
  }
);

Then(
  'it is the table {string} in {string}',
  (world, name: string, path: string) => {
    const pattern = new RegExp(
      `(<!-- generated: ${name} -->\\n)([\\s\\S]*?)(<!-- end: ${name} -->)`
    );
    const text = read(path);
    const expected = `\n${generatedTables.get(world)!}\n\n`;
    if (process.env['DEVFLEET_UPDATE_DOCS'])
      writeFileSync(
        resolve(root, path),
        text.replace(
          pattern,
          (_all, open: string, _old, close: string) =>
            `${open}${expected}${close}`
        )
      );
    else expect(pattern.exec(text)?.[2]).toBe(expected);
  }
);

// ── Support matrix ───────────────────────────────────────────────────────

When('docs\\/support-matrix.md is read', (world) => {
  world.output = read('docs/support-matrix.md');
});

Then('its table is the one the policies generate', (world) => {
  expect(world.output).toContain(`\n${renderSupportMatrix()}\n`);
});

/** WSL is how most text names WSL2. */
const spellings = (name: string): string[] =>
  name === 'WSL2' ? ['WSL2', 'WSL'] : [name];
const platformsNamed = (text: string, names: string[]): string[] =>
  names.filter((name) =>
    spellings(name).some((spelling) =>
      new RegExp(`(?<![\\w-])${spelling}(?![\\w-])`).test(text)
    )
  );

When(
  'the code and the features are searched for these platform names:',
  async (world, table: DataTable) => {
    const paths = (
      await Promise.all(
        [
          'src/**/*.ts',
          'bootstrap/**/*',
          'ansible/**/*.{yml,sh,py}',
          'features/**/*.feature',
        ].map(files)
      )
    )
      .flat()
      // This feature names every platform it looks for.
      .filter((path) => path !== 'features/rules/support-matrix.feature');
    world.searched = paths.length;
    world.found = [
      ...new Set(
        paths.flatMap((path) => platformsNamed(read(path), table.list()))
      ),
    ];
  }
);

When(
  'this text is searched for the platform names {string}:',
  (world, names: string, text: string) => {
    world.found = platformsNamed(text, names.split(','));
  }
);

const unlisted = (world: RulesWorld): string[] => {
  const listed = new Set(supportMatrix().map((row) => row.platform));
  return world.found.filter((name) => !listed.has(name));
};

Then('each name found is a platform of the support matrix', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
  expect(unlisted(world)).toEqual([]);
});

Then(
  'it names {string}, which has no row in the support matrix',
  (world, platform: string) => {
    expect(unlisted(world)).toEqual([platform]);
  }
);

// ── Who repairs a check ──────────────────────────────────────────────────

When('the check IDs the sources report are listed', (world) => {
  world.found = reportedCheckIds().map((entry) => entry.id);
});
Then('more than {int} check IDs were found', (world, count: number) => {
  expect(world.found.length).toBeGreaterThan(count);
});
Then(
  'every check ID found maps to a repair recipe or to a documented manual reason',
  (world) => {
    const unowned = world.found.filter((id) => {
      if (!checkOwner(id)) return true;
      const repair = checkRepair(id);
      return 'recipe' in repair
        ? !REPAIR_RECIPES.some((entry) => entry.id === repair.recipe)
        : repair.manual.length < 20;
    });
    expect(unowned).toEqual([]);
  }
);
Then(
  'the check {string} is repaired by {string}',
  (_world, id: string, repair: string) => {
    const check = { id, status: 'fail' as const, summary: '' };
    if (repair === 'a person') {
      expect(repairId(check)).toBe('operator');
      expect(manualReason(check)).toBeTruthy();
    } else {
      expect(repairId(check)).toBe(repair);
      expect(REPAIR_RECIPES.map((entry) => entry.id)).toContain(repair);
    }
  }
);
Then(
  'every recipe that repairs a machine names a playbook, a tag and nothing else',
  async () => {
    for (const entry of REPAIR_RECIPES.filter((recipe) =>
      recipe.owner.includes('(tag ')
    )) {
      const [command] = entry.commands;
      expect(command?.[0]).toBe('ansible-playbook');
      expect(command).toHaveLength(4);
      const [, path, flag, tag] = command!;
      expect(flag).toBe('--tags');
      expect(read(path!)).toContain(tag!);
    }
  }
);
Then(
  'a plan for a worker failing {string} and {string} says why the second is left to a person',
  (_world, repaired: string, manual: string) => {
    const steps = repairPlan(
      [
        {
          node: 'worker-one',
          checks: [repaired, manual].map((id) => ({
            id,
            status: 'fail' as const,
            summary: id,
          })),
        } as never,
      ],
      []
    );
    const owner = steps.find((step) => step.checks.includes(repaired))!;
    expect(owner.id).not.toBe('operator');
    expect(owner.manual).toBeUndefined();
    const person = steps.find((step) => step.checks.includes(manual))!;
    expect(person.id).toBe('operator');
    expect(person.manual).toEqual([
      { check: manual, reason: checkOwner(manual)!.manual! },
    ]);
  }
);

// ── The manager runbook ──────────────────────────────────────────────────

const RUNBOOK = 'docs/manager-recovery.md';
const REPLACING =
  /replac(e|ing) the manager|replacement manager|manager is lost/i;

async function fleetDocuments(): Promise<string[]> {
  // The fleet's own documents; a service's runbook (cliproxy/) is linked
  // from the manager's.
  return ['README.md', ...(await files('docs/*.md'))].filter(
    (path) => path !== RUNBOOK
  );
}

When(
  'the tracked documents that mention replacing the manager are read',
  async (world) => {
    world.found = (await fleetDocuments()).filter((path) =>
      REPLACING.test(read(path))
    );
  }
);
Then('there are at least {int} of them', (world, count: number) => {
  expect(world.found.length).toBeGreaterThanOrEqual(count);
});
Then('every one links to {string}', (world, target: string) => {
  expect(
    world.found.filter((path) => !read(path).includes(`${target})`))
  ).toEqual([]);
});
When(
  'the tracked documents are searched for {string}',
  async (world, text: string) => {
    world.found = [...(await fleetDocuments()), RUNBOOK].filter((path) =>
      read(path).includes(text)
    );
  }
);
Then('only these documents contain it:', (world, table: DataTable) => {
  expect(world.found.sort()).toEqual(table.list().sort());
});
// ── What a person does on the manager ────────────────────────────────────

When('the human steps of docs\\/manager-setup.md are read', (world) => {
  const text = read('docs/manager-setup.md');
  const table = text
    .split('<!-- human-steps -->')[1]!
    .split('<!-- /human-steps -->')[0]!;
  world.found = table
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map(
      (line) => /`([a-z0-9-]+:[a-z0-9:-]+)`\s*\|\s*$/.exec(line)?.[1] ?? line
    );
});

Then(
  'they are verified by these checks, in order:',
  (world, table: DataTable) => {
    expect(world.found).toEqual(table.list());
  }
);

Then(
  'every check that verifies one is a check fleet-sync reports',
  async (world) => {
    const sources = (await files('src/**/*.ts')).map(read).join('\n');
    for (const id of world.found) expect(sources).toContain(`'${id}'`);
  }
);

When('the playbook {string} is read', (world, path: string) => {
  world.script = read(path);
});

Then('no play of it becomes another user', (world) => {
  const plays = parse(world.script) as Record<string, unknown>[];
  expect(plays.length).toBeGreaterThan(1);
  for (const play of plays) {
    expect(play['become'] ?? false).toBe(false);
    expect(play['ansible.builtin.import_playbook']).toBeUndefined();
  }
});

Then(
  'everything it runs through sudo is one of:',
  (world, table: DataTable) => {
    const plays = parse(world.script) as { tasks?: Task[] }[];
    const allowed = table.list();
    const viaSudo = plays
      .flatMap((play) => play.tasks ?? [])
      .map(
        (task) =>
          (task['ansible.builtin.command'] as { argv?: string[] } | undefined)
            ?.argv
      )
      .filter((argv): argv is string[] => argv?.[0] === '/usr/bin/sudo')
      .map((argv) => argv.slice(2, 4).join(' '));
    expect(viaSudo.length).toBeGreaterThan(0);
    for (const command of viaSudo) expect(allowed).toContain(command);
  }
);

Then(
  'it changes the power settings only through {string}',
  (world, prefix: string) => {
    const [play] = parse(world.script) as { tasks: Task[] }[];
    const changes = play!.tasks
      .map(
        (task) =>
          (task['ansible.builtin.command'] as { argv?: string[] } | undefined)
            ?.argv
      )
      .filter((argv): argv is string[] => Boolean(argv?.includes('-c')));
    expect(changes.length).toBeGreaterThan(0);
    for (const argv of changes)
      expect(argv.slice(0, 2).join(' ')).toBe(
        prefix.replace('sudo', '/usr/bin/sudo')
      );
  }
);

// ── The launcher ─────────────────────────────────────────────────────────

/** The launcher in a package of its own, whose CLI says which Bun ran it. */
function installed(world: RulesWorld): NonNullable<RulesWorld['installed']> {
  if (world.installed) return world.installed;
  const at = mkdtempSync(join(tmpdir(), 'devfleet-launcher-'));
  world.defer(() => rmSync(at, { recursive: true, force: true }));
  for (const directory of ['bin', 'src/cli', 'node_modules/bun/bin', 'path'])
    mkdirSync(join(at, directory), { recursive: true });
  copyFileSync(join(root, 'bin/devfleet.mjs'), join(at, 'bin/devfleet.mjs'));
  writeFileSync(
    join(at, 'src/cli/cli.ts'),
    "console.log(process.env['DEVFLEET_TEST_BUN'] ?? 'the pinned Bun');\n"
  );
  writeFileSync(
    join(at, 'node_modules/bun/package.json'),
    JSON.stringify({ name: 'bun', version: '0.0.0' })
  );
  world.installed = { root: at, path: join(at, 'path'), status: null };
  return world.installed;
}

Given("the installed launcher's pinned Bun is a Bun executable", (world) => {
  symlinkSync(
    process.execPath,
    join(installed(world).root, 'node_modules/bun/bin/bun.exe')
  );
});

Given(
  "the installed launcher's pinned Bun is a stub left by skipped install scripts",
  (world) => {
    // What the bun package leaves before its postinstall replaces it: text
    // with no shebang, which Linux hands to /bin/sh.
    const stub = join(installed(world).root, 'node_modules/bun/bin/bun.exe');
    writeFileSync(
      stub,
      'echo "Bun\'s postinstall script was not run."\nexit 1\n'
    );
    chmodSync(stub, 0o755);
  }
);

Given('a Bun is on PATH', (world) => {
  const shim = join(installed(world).path, 'bun');
  writeFileSync(
    shim,
    `#!/bin/sh\nDEVFLEET_TEST_BUN='the Bun on PATH' exec '${process.execPath}' "$@"\n`
  );
  chmodSync(shim, 0o755);
});

Given('no Bun is on PATH', (world) => {
  installed(world);
});

When('the installed launcher is run', (world) => {
  const { root: at, path } = installed(world);
  const node = Bun.which('node');
  if (!node) throw new Error('These scenarios run the launcher with Node.');
  const env: Record<string, string> = { PATH: path };
  for (const name of ['HOME', 'TMPDIR', 'SYSTEMROOT'])
    if (process.env[name]) env[name] = process.env[name]!;
  const child = Bun.spawnSync([node, join(at, 'bin/devfleet.mjs')], {
    cwd: at,
    env,
  });
  world.installed!.status = child.exitCode;
  world.output = child.stdout.toString() + child.stderr.toString();
});

Then('the CLI runs on {}', (world, chosen: string) => {
  expect({
    status: world.installed?.status,
    output: world.output.trim(),
  }).toEqual({ status: 0, output: chosen });
});

Then(
  'it exits {int} and says {string}',
  (world, status: number, text: string) => {
    expect(world.installed?.status).toBe(status);
    expect(world.output).toContain(text);
  }
);
