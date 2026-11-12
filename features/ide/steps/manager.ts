import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { nativeT3Artifact } from '../../../bootstrap/native-t3';
import {
  managerVersion,
  STARTED_VERSION,
  updatesCheck,
  workerVersion,
} from '../../../src/t3/version';
import { succeeded } from '../../support/commands';
import { ide, ROOT, type IdeWorld } from './world';

const { Given, When, Then } = ide;

type Play = { tasks: { [module: string]: Record<string, unknown> }[] };
interface Manager {
  artifact?: { name: string; sha256: string; url: string } | null;
  policy?: string;
  playbook?: Play[];
}
const managers = new WeakMap<IdeWorld, Manager>();
const of = (world: IdeWorld): Manager => {
  let value = managers.get(world);
  if (!value) managers.set(world, (value = {}));
  return value;
};

const mise = (): string => readFileSync(join(ROOT, 'mise.toml'), 'utf8');

When(
  /^the pinned T3 archive for (\w+) (\w+) is resolved$/,
  (world, platform: string, architecture: string) => {
    const config = Bun.TOML.parse(mise()) as Parameters<
      typeof nativeT3Artifact
    >[0];
    try {
      of(world).artifact = nativeT3Artifact(config, architecture, platform);
    } catch {
      of(world).artifact = null;
    }
  }
);

Then(
  'it is the file {string} with a SHA-256 digest from mise.toml',
  (world, name: string) => {
    const artifact = of(world).artifact!;
    expect(artifact.url.endsWith(`/${name}`)).toBe(true);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mise()).toContain(`"${artifact.sha256}"`);
  }
);

Then('no archive is pinned', (world) => {
  expect(of(world).artifact).toBeNull();
});

Given(
  'T3 on the manager last started as {string}',
  (world, version: string) => {
    mkdirSync(join(world.t3Home, 'userdata'), { recursive: true });
    if (version)
      writeFileSync(join(world.t3Home, STARTED_VERSION), `${version}\n`);
  }
);

When('the T3 version of the manager is checked', async (world) => {
  world.checks = [await managerVersion(world.t3Home, ROOT)];
});

Given(
  'the worker {string} says over SSH that its T3 last started as {string}',
  (world, _node: string, version: string) => {
    world.commands.answer(
      (command) =>
        command[0] === 'ssh' && command.join(' ').includes(STARTED_VERSION),
      succeeded(`${version}\n`)
    );
  }
);

When(
  'the T3 version of the worker {string} is checked',
  async (world, id: string) => {
    world.checks = [
      await workerVersion(
        { id, ssh: id, workspace: '/w', required: [] },
        world.run,
        ROOT
      ),
    ];
  }
);

Given(
  'the T3 administrator policy on the manager is:',
  (world, text: string) => {
    of(world).policy = join(world.directory('ide-policy-'), 'policy.json');
    writeFileSync(of(world).policy!, text);
  }
);

When('the T3 updater of the manager is checked', async (world) => {
  world.checks = [
    await updatesCheck(of(world).policy!, 'ansible-playbook -K manager.yml'),
  ];
});

When("the manager's T3 playbook is read", (world) => {
  of(world).playbook = parse(
    readFileSync(join(ROOT, 'ansible/macos/t3-policy.yml'), 'utf8')
  ) as Play[];
});

const copies = (world: IdeWorld) =>
  of(world).playbook!.flatMap((play) =>
    play.tasks.flatMap((task) =>
      task['ansible.builtin.copy'] ? [task['ansible.builtin.copy']] : []
    )
  );
const policyDirectory = '/Library/Application Support/T3Code';

Then(
  'it installs {string} at {string}',
  (world, source: string, path: string) => {
    const install = copies(world).find((copy) =>
      String(copy['dest']).endsWith('/policy.json')
    )!;
    expect(String(install['content'])).toContain(`'${source}'`);
    expect(
      String(install['dest']).replace(
        '{{ t3_policy_directory }}',
        policyDirectory
      )
    ).toBe(path);
  }
);

Then('it records the ownership marker {string}', (world, marker: string) => {
  const record = copies(world).find((copy) =>
    String(copy['dest']).endsWith('/.personal-fleet-policy')
  )!;
  expect(record['content']).toBe(`${marker}\n`);
  // The same text the workers' policy playbook records.
  expect(
    readFileSync(join(ROOT, 'ansible/ubuntu/t3-policy.yml'), 'utf8')
  ).toContain(`content: "${marker}\\n"`);
});

Then('{string} imports it', (_world, playbook: string) => {
  const plays = parse(readFileSync(join(ROOT, playbook), 'utf8')) as Record<
    string,
    unknown
  >[];
  expect(
    plays.some(
      (play) => play['ansible.builtin.import_playbook'] === 't3-policy.yml'
    )
  ).toBe(true);
});
