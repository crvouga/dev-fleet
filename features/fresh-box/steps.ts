import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import policy from '../../ansible/ubuntu/policy.json';
import { packagePins, ubuntuRelease } from '../../src/platform/ubuntu-release';
import { sshArgs } from '../../src/ssh';
import { World, steps, type DataTable } from '../support/gherkin';
import {
  BEFOREHAND,
  RELEASE_UNDER_TEST,
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
  /** MiB measured on the machine, by what was measured. */
  measured: Record<string, number> = {};

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
  'a fresh machine of the Ubuntu release under test, with an SSH server and an account that can use sudo',
  async (world) => {
    expect(ubuntuRelease(RELEASE_UNDER_TEST)).toBeDefined();
    world.machine = await box(FRESH_BOX);
    world.revision = (await sshClient()).revision;
    expect(
      (await world.remote('. /etc/os-release && echo "$VERSION_ID"')).stdout
    ).toBe(RELEASE_UNDER_TEST);
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
  'these packages are installed at the exact version the Ubuntu policy pins for the release:',
  async (world, table: DataTable) => {
    const packages = packagePins(ubuntuRelease(RELEASE_UNDER_TEST));
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

Then('it took less than {int} seconds', async (world, seconds: number) => {
  if (world.bootstrap.seconds >= seconds) {
    // Every Ansible task on the machine is logged with its time (the
    // Dockerfile sets ANSIBLE_LOG_PATH for SSH sessions): name the slowest.
    const slowest = await world.remote(
      `awk -F' [|] ' '/TASK \\[|PLAY \\[/ { split($1, t, /[ ,]/); split(t[2], h, ":"); now = h[1] * 3600 + h[2] * 60 + h[3]; if (task) print now - start, task; task = $NF; start = now }' /tmp/fleet-ansible.log | sort -rn | head -10`
    );
    console.log(`\nSlowest Ansible tasks (seconds):\n${slowest.stdout}`);
  }
  expect(world.bootstrap.seconds).toBeLessThan(seconds);
});

// ── Disk footprint ───────────────────────────────────────────────────────

const MISE = '$HOME/.local/share/mise';
// Rust's toolchains live with rustup, outside mise's own directory.
const HOME = '$HOME';
const FLEET = '$HOME/.local/share/personal/fleet';
type Budget = keyof typeof policy.sizing.footprintMiB.profiles;

/** MiB a path takes on the machine (hard links counted once). */
async function mebibytes(world: FreshBoxWorld, path: string): Promise<number> {
  const result = await world.remote(`du -smx ${path} | cut -f1`);
  expect(result.ok).toBe(true);
  return Number(result.stdout);
}

function report(world: FreshBoxWorld, what: string, mib: number): void {
  world.measured[what] = mib;
  // For the worker contract: the measured footprint of each part.
  console.log(
    `footprint ${RELEASE_UNDER_TEST} ${process.arch} ${what}: ${mib} MiB`
  );
}

When('the disk dev-fleet uses on the machine is measured', async (world) => {
  report(world, 'tools', await mebibytes(world, MISE));
  report(world, 'checkouts', await mebibytes(world, `${FLEET}/revisions`));
});

Then(
  'the base tools and the {string} profile take at most the budget of {string} plus the {string} profile',
  (world, _profile: string, budget: string, profile: string) => {
    const budgets = policy.sizing.footprintMiB;
    expect(world.measured['tools']!).toBeLessThanOrEqual(
      (budgets[budget as 'baseTools'] as number) +
        budgets.profiles[profile as Budget]
    );
  }
);

Then(
  "the fleet's checkouts take at most the budget of {string}",
  (world, budget: string) => {
    expect(world.measured['checkouts']!).toBeLessThanOrEqual(
      policy.sizing.footprintMiB[budget as 'checkouts'] as number
    );
  }
);

When(
  'the tools of the {string} profile are installed on the machine',
  async (world, profile: string) => {
    const tools = (
      await world.remote(
        `cd "${FLEET}/revisions/${world.revision}" && sed -n 's/^worker_profile_${profile} = "\\(.*\\)"$/\\1/p' mise.toml`
      )
    ).stdout
      .split('\n')
      .pop()!;
    expect(tools).not.toBe('');
    const installed = await world.remote(
      `cd "${FLEET}/revisions/${world.revision}" && "$HOME/.local/bin/mise" install --locked ${tools.split(',').join(' ')} >/dev/null 2>&1`
    );
    expect(installed.ok).toBe(true);
    // What its tools occupy, wherever an earlier step installed them: each
    // tool's install directory, and for Rust the toolchain rustup keeps.
    const sized = await world.remote(
      `cd "${FLEET}/revisions/${world.revision}" && du -smxc $(for tool in ${tools.split(',').join(' ')}; do "$HOME/.local/bin/mise" where "$tool"; done) ${profile === 'rust' ? `$(ls -d ${HOME}/.rustup/toolchains/* 2>/dev/null)` : ''} | tail -1 | cut -f1`
    );
    expect(sized.ok).toBe(true);
    report(world, profile, Number(sized.stdout));
  }
);

Then(
  'they take at most the budget of the {string} profile',
  (world, profile: string) => {
    expect(world.measured[profile]!).toBeLessThanOrEqual(
      policy.sizing.footprintMiB.profiles[profile as Budget]
    );
  }
);
