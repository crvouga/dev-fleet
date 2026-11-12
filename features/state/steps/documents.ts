import { expect } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecord, type RunRecord } from '../../../src/cli/fleet-sync-state';
import { addNode, loadRoster, readRoster } from '../../../src/cli/roster';
import { resolveSettings, type Settings } from '../../../src/cli/settings';
import type { Enrollment } from '../../../src/machine/state';
import { loadEnrollment, storeEnrollment } from '../../../src/state/enrollment';
import {
  adoptEarlier,
  legacyPath,
  readLegacy,
} from '../../../src/state/legacy';
import { readRosterText, writeRosterText } from '../../../src/state/roster';
import { mutateState, refresh, type Standing } from '../../../src/state/sync';
import type { Check, FleetConfig, FleetNode } from '../../../src/types';
import { NODE } from '../../support/fixtures';
import type { DataTable } from '../../support/gherkin';
import { write } from './common';
import {
  DOCUMENT,
  EXAMPLE,
  EXAMPLE_FILE,
  WHO,
  act,
  documentName,
  json,
  phrase,
  scratch,
  state,
  type StateWorld,
} from './world';

const { Given, When, Then } = state;

// ── Which roster a command uses ──────────────────────────────────────────

const workspace = (world: StateWorld): string => join(world.root, 'workspace');
const settings = (world: StateWorld, config?: string): Promise<Settings> =>
  resolveSettings(config === undefined ? {} : { config }, workspace(world), {
    PERSONAL_WORKSPACE: workspace(world),
  });

Given('a workspace', (world) => {
  mkdirSync(workspace(world), { recursive: true });
});
Given('the workspace holds {string}:', (world, name: string, text: string) => {
  write(join(workspace(world), name), text);
});
When('a command resolves its settings in the workspace', (world) =>
  world.attempt(() => settings(world))
);
When(
  'a command resolves its settings in the workspace with the roster {string}',
  (world, roster: string) => world.attempt(() => settings(world, roster))
);
When(
  'a command resolves its settings in the workspace with the roster file {string}',
  (world, name: string) =>
    world.attempt(() => settings(world, join(workspace(world), name)))
);
Then('its roster is {string}', (world, roster: string) => {
  expect(world.outcome<Settings>().config).toBe(roster);
});
Then('its roster is the file {string} in the workspace', (world, name) => {
  expect(world.outcome<Settings>().config).toBe(
    join(workspace(world), name as string)
  );
});

// ── The roster of the manager this process runs on ───────────────────────

Given('the process runs on a manager with an empty fleet state', (world) => {
  world.bind(world.manager());
});

const worker = (table: DataTable): FleetNode => {
  const [row] = table.hashes();
  return {
    ...NODE,
    id: row!['id']!,
    ssh: row!['ssh']!,
    workspace: row!['workspace']!,
  };
};

When('the roster {string} is read', (world, path: string) =>
  world.attempt(() => readRoster(path))
);
When('the roster {string} is loaded for a fleet-sync', (world, path: string) =>
  world.attempt(() => loadRoster(path))
);
When(
  'this worker is previewed in the roster {string}:',
  (world, path: string, table: DataTable) =>
    world.attempt(() => addNode(path, worker(table), false))
);
Given(
  /^this worker (is|was) added to the roster "([^"]+)":$/,
  (world, verb: string, path: string, table: DataTable) =>
    act(world, verb, () =>
      addNode(path, worker(table), true, () => world.manager().context)
    )
);

Then(/^there is no (roster|enrollment)$/, (world) => {
  expect(world.outcome()).toBeNull();
});
Then('the roster it shows lists {int} worker(s)', (world, count: number) => {
  expect(world.outcome<{ roster: FleetConfig }>().roster.nodes).toHaveLength(
    count
  );
});
Then('there is still no roster {string}', async (_world, path: string) => {
  expect(await readRoster(path)).toBeNull();
});
Then(
  'the roster {string} lists these workers:',
  async (_world, path: string, table: DataTable) => {
    expect((await loadRoster(path)).nodes.map((node) => node.id)).toEqual(
      table.list()
    );
  }
);

// ── What a manager kept in files before it had a fleet state ─────────────

Given(
  phrase(WHO, ' kept its ', DOCUMENT, ' in "([^"]+)":'),
  (
    world,
    name: string | undefined,
    document: string,
    path: string,
    text: string
  ) => {
    const manager = world.manager(name);
    const earlier = world.expand(path, manager);
    // The path a feature names is the one the product reads.
    expect(legacyPath(documentName(document), manager.env, manager.home)).toBe(
      earlier
    );
    write(earlier, text);
  }
);

Given(
  phrase(
    WHO,
    ' kept the example fleet(\\.json)? as its configuration in "([^"]+)"'
  ),
  (world, name: string | undefined, tracked: string | undefined, path) => {
    const manager = world.manager(name);
    const earlier = world.expand(path as string, manager);
    expect(legacyPath('definition', manager.env, manager.home)).toBe(earlier);
    write(earlier, readFileSync(tracked ? EXAMPLE_FILE : EXAMPLE, 'utf8'));
  }
);

When(
  phrase('the roster "([^"]+)" of ', WHO, ' is read as text'),
  (world, path: string, name: string | undefined) => {
    const manager = world.manager(name);
    return world.attempt(() => readRosterText(path, manager.env, manager.home));
  }
);
Then('it reads:', (world, text: string) => {
  expect(world.outcome<string | null>()).toBe(text);
});

Given(
  phrase('the roster "([^"]+)" of ', WHO, ' (is|was) written as:'),
  (world, path: string, name: string | undefined, verb: string, text: string) =>
    act(world, verb, () => {
      const manager = world.manager(name);
      return writeRosterText(path, text, manager.env, manager.home);
    })
);

When(
  phrase('the earlier files of ', WHO, ' are moved into the fleet state'),
  (world, name: string | undefined) => {
    const manager = world.manager(name);
    return world.attempt(() => adoptEarlier(manager.env, manager.home));
  }
);
Then('nothing is moved', (world) => {
  expect(world.outcome<string[]>()).toEqual([]);
});
Then('these documents are moved:', (world, table: DataTable) => {
  expect(world.outcome<string[]>()).toEqual(table.list());
});
Then(
  phrase('the earlier ', DOCUMENT, ' of ', WHO, ' is no longer read'),
  (world, document: string, name: string | undefined) => {
    const manager = world.manager(name);
    expect(
      readLegacy(documentName(document), manager.env, manager.home)
    ).toBeNull();
  }
);
Then(
  phrase(WHO, ' has no earlier ', DOCUMENT, ' file'),
  (world, name: string | undefined, document: string) => {
    const manager = world.manager(name);
    expect(legacyPath(documentName(document), manager.env, manager.home)).toBe(
      null
    );
  }
);

// ── The enrollment: the approved and the applied revision ────────────────

When(
  phrase(
    'the enrollment of ',
    WHO,
    ' is loaded(?:, with "([^"]+)" as where it was kept before)?'
  ),
  (world, name: string | undefined, earlier: string | undefined) => {
    const manager = world.manager(name);
    return world.attempt(() =>
      loadEnrollment(
        earlier ? world.expand(earlier, manager) : null,
        manager.stateEnv
      )
    );
  }
);
Then('its approved revision is {string}', (world, revision: string) => {
  expect(world.outcome<Enrollment | null>()?.approvedRevision).toBe(revision);
});

Given(
  phrase(WHO, ' stored the enrollment:'),
  (world, name: string | undefined, text: string) => {
    storeEnrollment(json(text) as Enrollment, world.manager(name).stateEnv);
  }
);
Given(
  phrase(WHO, ' stored the enrollment and uploaded it:'),
  async (world, name: string | undefined, text: string) => {
    const manager = world.manager(name);
    await mutateState(manager.context, () =>
      storeEnrollment(json(text) as Enrollment, {
        DEVFLEET_STATE: manager.root,
      })
    );
  }
);

Then(
  phrase('the enrollment of ', WHO, ' is exactly:'),
  async (world, name: string | undefined, text: string) => {
    expect(await loadEnrollment(null, world.manager(name).stateEnv)).toEqual(
      json(text) as Enrollment
    );
  }
);
Then(
  phrase('the approved revision of ', WHO, ' is "([a-f0-9]{40})"'),
  async (world, name: string | undefined, revision: string) => {
    expect(
      (await loadEnrollment(null, world.manager(name).stateEnv))
        ?.approvedRevision
    ).toBe(revision);
  }
);
Then(phrase(WHO, ' has no enrollment'), async (world, name?: string) => {
  expect(await loadEnrollment(null, world.manager(name).stateEnv)).toBeNull();
});

// ── What one fleet-sync run records ──────────────────────────────────────

const runs = scratch<{
  record?: RunRecord;
  /** How the manager's copy stood when the run started. */
  started?: Standing;
  /** The Litestream commands started before the run recorded anything. */
  callsAtStart: number;
}>(() => ({ callsAtStart: 0 }));

/** As fleet-sync does: bring the copy up to the bucket, read what the last
 * run recorded, then record this run's approval.
 */
async function approve(world: StateWorld, revision: string): Promise<void> {
  const manager = world.manager();
  const run = runs(world);
  run.started = (await refresh(manager.context)).standing;
  run.callsAtStart = world.litestream.calls.length;
  run.record = runRecord(
    await loadEnrollment(null, manager.stateEnv),
    revision,
    {
      context: manager.context,
      standing: run.started,
      env: manager.stateEnv,
    }
  );
  run.record.approve();
}

Given(
  /^a fleet-sync run for revision "([a-f0-9]{40})" (?:is|was) approved$/,
  (world, revision: string) => approve(world, revision)
);
Given(
  /^a fleet-sync run for revision "([a-f0-9]{40})" (converged|ended without converging)$/,
  async (world, revision: string, how: string) => {
    await approve(world, revision);
    await runs(world).record!.settle(how === 'converged');
  }
);
Given(/^the run (converges|converged)$/, (world, verb: string) =>
  act(world, verb, () => runs(world).record!.settle(true))
);
When('the run ends without converging', (world) =>
  world.attempt(() => runs(world).record!.settle(false))
);
When(
  'the run ends without converging, with these workers converged:',
  (world, table: DataTable) =>
    world.attempt(() => runs(world).record!.settle(false, table.rowsHash()))
);
When('the run stops before its report', (world) =>
  world.attempt(() => runs(world).record!.abandon())
);

Then(
  'its report carries the check {string} as {string}',
  (world, id: string, status: string) => {
    expect(world.outcome<Check>()).toMatchObject({ id, status });
  }
);
Then('the run had started {string}', (world, expected: string) => {
  expect(runs(world).started).toBe(expected as Standing);
});
Then('Litestream was not started after the run began', (world) => {
  expect(world.litestream.calls.length).toBe(runs(world).callsAtStart);
});
