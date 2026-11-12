import { expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import macos from '../../ansible/macos/policy.json';
import ubuntu from '../../ansible/ubuntu/policy.json';
import beszel from '../../ansible/monitoring/lock.json';
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
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      strategy?: { matrix?: { include?: Record<string, string>[] } };
      services?: Record<string, { image: string }>;
      steps: WorkflowStep[];
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
    const floating = installs(world)
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
  world.found = (/^for package in (.+); do$/m.exec(read(path))?.[1] ?? '')
    .split(' ')
    .filter(Boolean);
});

Then('each is a package the Ubuntu policy pins', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
  for (const name of world.found)
    expect(Object.keys(ubuntu.packages)).toContain(name);
});

Then(
  '{string} requires the Ubuntu release of the Ubuntu policy',
  (_world, path: string) => {
    expect(read(path)).toContain(`= ${ubuntu.release} ]`);
  }
);

Then(
  '{string} requires the minimum macOS version of the macOS policy',
  (_world, path: string) => {
    expect(read(path)).toContain(`-ge ${macos.minimumMajorVersion} ]`);
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
const jobEnv = (world: RulesWorld, name: string): Record<string, string> =>
  Object.assign({}, ...job(world, name).steps.map((step) => step.env ?? {}));

When(
  'the steps of the {string} workflow that install mise are read',
  async (world, name: string) => {
    world.workflowSteps = Object.values((await workflow(name)).jobs)
      .flatMap((entry) => entry.steps)
      .filter((step) => step.uses?.startsWith('jdx/mise-action@'));
    world.found = world.workflowSteps.map((step) => String(step.uses));
  }
);

Then('there is at least one', (world) => {
  expect(world.found.length).toBeGreaterThan(0);
});

Then('each installs the mise version mise.toml pins', (world) => {
  for (const step of world.workflowSteps)
    expect(step.with?.['version']).toBe(pin('min_version')!);
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
    for (const action of world.found)
      expect(action).toMatch(
        /^[\w.-]+\/[\w.-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/
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
      job(world, name).steps.some((step) => step.run?.includes(command))
    ).toBe(true);
  }
);

When(
  'the {string} step of the {string} workflow is read',
  async (world, step: string, name: string) => {
    world.script =
      Object.values((await workflow(name)).jobs)
        .flatMap((entry) => entry.steps)
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
    expect(job(world, name).strategy?.matrix?.include).toEqual(table.hashes());
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
