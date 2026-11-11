import { expect } from 'bun:test';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { succeeded } from '../../support/commands';
import { machine } from './machine';
import { useHome } from './t3';
import { cli, json, part, temporary, where } from './world';

const { Given, Then } = cli;

const SHIPPED = resolve(import.meta.dir, '../../../agents/t3.json');
const RECEIPT = 'node_modules/.personal-node.json';

const checkout = part(() => ({ revision: '' }));

Given(
  'a checkout at the commit {string}, with that revision unpacked under {string}',
  async (world, commit: string, revisions: string) => {
    const root = await temporary(world, 'personal-node-');
    const revision = join(root, revisions, commit);
    await mkdir(revision, { recursive: true });
    checkout(world).revision = revision;
    world.names['CHECKOUT'] = root;
    world.where = { workspace: root, config: join(root, 'roster.json') };
    useHome(world, join(root, 't3'));
    // Git names the commit, and the unpacked revision as the top of its tree;
    // everything else the sync runs succeeds and prints nothing.
    const { commands } = machine(world);
    commands.otherwise = succeeded();
    commands.answer((command) => command[1] === 'rev-parse', succeeded(commit));
    commands.answer(
      (command) => command.includes('--show-toplevel'),
      succeeded(revision)
    );
  }
);

Given(
  'the revision carries the T3 definition the package ships',
  async (world) => {
    const agents = join(checkout(world).revision, 'agents');
    await mkdir(agents, { recursive: true });
    await copyFile(SHIPPED, join(agents, 't3.json'));
  }
);

Given(
  'applying a profile in the revision answers:',
  (world, answer: string) => {
    machine(world).commands.answer(
      (command) =>
        command.includes('apply') &&
        command[1] !== 'rev-parse' &&
        !command.includes('--show-toplevel'),
      succeeded(JSON.stringify(json(answer)))
    );
  }
);

Then(
  'the receipt of the checkout names the revision {string}',
  async (world, revision: string) => {
    expect(
      (
        (await Bun.file(join(where(world).workspace, RECEIPT)).json()) as {
          revision: string;
        }
      ).revision
    ).toBe(revision);
  }
);

Then('the checkout has no receipt', async (world) => {
  expect(await Bun.file(join(where(world).workspace, RECEIPT)).exists()).toBe(
    false
  );
});
