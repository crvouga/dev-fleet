import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ubuntu from '../../ansible/ubuntu/policy.json';
import { ubuntuRelease } from '../../src/platform/ubuntu-release';
import { sshArgs } from '../../src/ssh';
import { World, steps, type DataTable } from '../support/gherkin';
import {
  BEFOREHAND,
  bootstrap,
  box,
  firstBootstrap,
  reachedConvergence,
  remote,
  repo,
  sshClient,
  type Bootstrap,
  type Box,
} from './support/boxes';

/** The machine of the single-machine feature. */
const FRESH_BOX = 'fresh-box';

export class FreshBoxWorld extends World {
  machine!: Box;
  revision = '';
  bootstrap!: Bootstrap;
  worktree = '';

  /** A command on the machine, over the same SSH transport fleet-sync uses. */
  remote(command: string): Promise<{ ok: boolean; stdout: string }> {
    return remote(this.machine, command);
  }
  /** In the checkout of the commit under test, with the pinned tools. */
  pinned(
    tool: string,
    command: string
  ): Promise<{ ok: boolean; stdout: string }> {
    return this.remote(
      `cd "$HOME/.local/share/personal/fleet/revisions/${this.revision}" && "$HOME/.local/bin/mise" exec --locked ${tool} -- ${command} 2>&1`
    );
  }
}

export const freshBox = steps<FreshBoxWorld>();
const { Given, When, Then } = freshBox;

Given(
  'a fresh Ubuntu {float} machine with an SSH server and an account that can use sudo',
  async (world, release: number) => {
    expect(ubuntuRelease(release.toFixed(2))).toBeDefined();
    world.machine = await box(FRESH_BOX);
    world.revision = (await sshClient()).revision;
    expect(
      (await world.remote('. /etc/os-release && echo "$VERSION_ID"')).stdout
    ).toBe(release.toFixed(2));
    expect((await world.remote('id -u')).stdout).not.toBe('0');
    expect((await world.remote('sudo -n true')).ok).toBe(true);
  }
);

Given(
  "the manager reaches it over SSH with its own key and the machine's verified host key",
  async (world) => {
    // The production options: batch mode, strict host keys, no agent.
    expect(sshArgs(world.machine.node)).toContain('StrictHostKeyChecking=yes');
    expect((await world.remote('whoami')).stdout).toBe('fleettest');
  }
);

Then(
  'the machine had none of these commands when it was created:',
  (world, table: DataTable) => {
    expect(table.list().sort()).toEqual([...BEFOREHAND].sort());
    expect(world.machine.present).toEqual([]);
  }
);

const bootstrapped = async (world: FreshBoxWorld): Promise<void> => {
  world.bootstrap = await firstBootstrap(world.machine);
};
When(
  'the manager bootstraps the machine at the commit under test',
  bootstrapped
);
Given('the manager has bootstrapped the machine', bootstrapped);

When('the manager bootstraps the machine again', async (world) => {
  world.bootstrap = await bootstrap(world.machine);
});

/** Reaching node convergence proves the machine needed nothing beforehand:
 * source transfer, operating system prerequisites, the locked toolchain and
 * frozen dependencies. A bootstrap that stops early reports a `bootstrap:` or
 * `ssh:` check instead of the node's own.
 */
Then('the bootstrap reaches node convergence', (world) => {
  expect(reachedConvergence(world.bootstrap.checks)).toBe(true);
});

Then(
  'the machine holds the commit under test, checked out without its history',
  async (world) => {
    const checkout = `"$HOME/.local/share/personal/fleet/revisions/${world.revision}"`;
    expect(
      (await world.remote(`git -C ${checkout} rev-parse HEAD`)).stdout
    ).toBe(world.revision);
    expect(
      (await world.remote(`git -C ${checkout} rev-list --count HEAD`)).stdout
    ).toBe('1');
    expect((await world.remote(`test -d ${checkout}/node_modules`)).ok).toBe(
      true
    );
  }
);

Then(
  'the machine holds the fleet configuration, without the bucket it names',
  async (world) => {
    const installed = JSON.parse(
      (await world.remote('cat "$HOME/.config/dev-fleet/fleet.json"')).stdout
    ) as Record<string, unknown>;
    const example = JSON.parse(
      await readFile(resolve(repo, 'examples/fleet.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(example['state']).toBeDefined();
    expect(installed['state']).toBeUndefined();
    expect(installed['manager']).toEqual(example['manager']);
    expect(installed['workers']).toEqual(example['workers']);
  }
);

const miseToml = async (): Promise<{
  min_version: string;
  tools: Record<string, string | { version: string }>;
}> =>
  Bun.TOML.parse(await readFile(resolve(repo, 'mise.toml'), 'utf8')) as never;

Then('the machine runs the mise release mise.toml pins', async (world) => {
  const { min_version: pinned } = await miseToml();
  expect(
    (await world.remote('"$HOME/.local/bin/mise" --version')).stdout
  ).toStartWith(pinned);
});

Then('the devfleet launcher is installed on the machine', async (world) => {
  expect((await world.remote('test -x "$HOME/.local/bin/devfleet"')).ok).toBe(
    true
  );
});

Then(
  'these tools run on the machine at the version mise.toml pins:',
  async (world, table: DataTable) => {
    const { tools } = await miseToml();
    for (const { tool, command } of table.hashes()) {
      const pin = tools[tool!];
      const version = typeof pin === 'string' ? pin : pin!.version;
      expect(
        `${tool}: ${(await world.pinned(tool!, command!)).stdout}`
      ).toContain(version);
    }
  }
);

Then(
  'these packages are installed at the exact version the Ubuntu policy pins:',
  async (world, table: DataTable) => {
    const packages: Record<string, string> = ubuntu.packages;
    for (const name of table.list()) {
      const installed = await world.remote(
        `dpkg-query -W -f='\${Version}' ${name}`
      );
      expect(`${name}=${installed.stdout}`).toBe(`${name}=${packages[name]}`);
    }
  }
);

Then(
  'the machine reports these checks as passed:',
  (world, table: DataTable) => {
    const passed = world.bootstrap.checks
      .filter((check) => check.status === 'pass')
      .map((check) => check.id);
    for (const id of table.list()) expect(passed).toContain(id);
  }
);

When(
  'an agent creates a worktree with its own mise.toml on the machine',
  async (world) => {
    world.worktree = '$HOME/.t3/worktrees/fresh-box/check';
    const made = await world.remote(
      `w="${world.worktree}" && mkdir -p "$w" && printf '[env]\\nFRESH_BOX = "1"\\n' > "$w/mise.toml"`
    );
    expect(made.ok).toBe(true);
  }
);

Then(
  'the pinned tools resolve there without anyone trusting it',
  async (world) => {
    const resolved = await world.remote(
      `cd "${world.worktree}" && "$HOME/.local/bin/mise" which claude`
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.stdout).toContain('claude');
  }
);

Then('the commit was not sent again', (world) => {
  expect(world.bootstrap.transferred).toBe(false);
});

Then('it took less than {int} seconds', (world, seconds: number) => {
  expect(world.bootstrap.seconds).toBeLessThan(seconds);
});
