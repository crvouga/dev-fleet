import { expect } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBucket } from '../../../src/state/bucket';
import { readDocument, writeDocument } from '../../../src/state/store';
import {
  mutateState,
  pending,
  pull,
  push,
  refresh,
  standing,
  type Refreshed,
  type Standing,
} from '../../../src/state/sync';
import type { Runner } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { fakeLitestream } from '../support/litestream-fake';
import {
  DOCUMENT,
  WHO,
  act,
  documentName,
  phrase,
  scratch,
  state,
  type Manager,
  type StateWorld,
} from './world';

const { Given, Then } = state;

const seen = scratch<{
  /** What the last change found before it was made. */
  before?: { standing: Standing; configuration: string | null };
  /** How each change of a series stood afterwards. */
  series: Standing[];
  /** Every command a manager without Litestream started. */
  commands: string[][];
}>(() => ({ series: [], commands: [] }));

// ── Where a manager replicates to ────────────────────────────────────────

function replicateToBucket(world: StateWorld, manager: Manager): void {
  manager.bucket = parseBucket({ directory: world.remote });
  manager.run = world.litestream.run;
}

Given(
  'managers {string} and {string} replicate to one bucket',
  (world, first: string, second: string) => {
    for (const name of [first, second])
      replicateToBucket(world, world.manager(name));
  }
);
Given(
  phrase(WHO, ' replicates to the bucket'),
  (world, name: string | undefined) => {
    replicateToBucket(world, world.manager(name));
  }
);
Given(phrase(WHO, ' has no bucket'), (world, name: string | undefined) => {
  world.manager(name).bucket = null;
});

Given(
  phrase(
    WHO,
    ' replicates to the S3 bucket "([^"]+)" at "([^"]+)" with the keys "([^"]+)" and "([^"]+)"'
  ),
  (
    world,
    name: string | undefined,
    bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string
  ) => {
    const manager = world.manager(name);
    manager.bucket = parseBucket({
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
    });
    manager.run = world.litestream.run;
  }
);

Given(
  phrase(WHO, ' (is|was) pointed at another bucket that holds nothing'),
  (world, name: string | undefined) => {
    const manager = world.manager(name);
    const other = `${world.remote}-other`;
    manager.bucket = parseBucket({ directory: other });
    manager.run = fakeLitestream(other).run;
  }
);

Given(
  phrase('the pinned Litestream is not installed where ', WHO, ' runs'),
  (world, name: string | undefined) => {
    const { commands } = seen(world);
    let installed = false;
    // mise answers; it finds Litestream only once it was asked to install it.
    const run: Runner = async (argv) => {
      commands.push(argv);
      if (argv[1] === 'install') installed = true;
      return {
        ok: argv[1] === 'install' || (argv[1] === 'which' && installed),
        stdout: '/pinned/litestream\n',
        stderr: '',
        reason: 'exit',
      };
    };
    world.manager(name).run = run;
  }
);

// ── What a manager does ──────────────────────────────────────────────────

function change(
  world: StateWorld,
  manager: Manager,
  document: string,
  text: string
) {
  return mutateState(manager.context, (before) => {
    seen(world).before = {
      standing: before,
      configuration: readDocument(manager.database, 'definition'),
    };
    return writeDocument(manager.database, documentName(document), text);
  });
}

Given(
  phrase(
    WHO,
    ' (changes|changed|tried to change) the ',
    DOCUMENT,
    ' to "([^"]*)"'
  ),
  (
    world,
    name: string | undefined,
    verb: string,
    document: string,
    text: string
  ) =>
    act(world, verb, () => change(world, world.manager(name), document, text))
);

Given(
  phrase(WHO, ' (makes|made) these changes to the configuration in turn:'),
  (world, name: string | undefined, verb: string, table: DataTable) =>
    act(world, verb, async () => {
      const manager = world.manager(name);
      const { series } = seen(world);
      series.length = 0;
      for (const text of table.list())
        series.push(
          (await change(world, manager, 'configuration', text)).standing
        );
    })
);

Given(
  phrase(WHO, ' (compares|compared) its copy with the bucket'),
  (world, name: string | undefined, verb: string) =>
    act(world, verb, () => standing(world.manager(name).context))
);
Given(
  phrase(WHO, ' (refreshes|refreshed) its copy'),
  (world, name: string | undefined, verb: string) =>
    act(world, verb, () => refresh(world.manager(name).context))
);
Given(
  phrase(WHO, ' (pushes|pushed|tried to push) its changes'),
  (world, name: string | undefined, verb: string) =>
    act(world, verb, () => push(world.manager(name).context))
);
Given(
  phrase(WHO, ' (restores|restored) its copy from the bucket'),
  (world, name: string | undefined, verb: string) =>
    act(world, verb, () => pull(world.manager(name).context))
);

// ── How a copy stands ────────────────────────────────────────────────────

Then('it reports {string}', (world, expected: string) => {
  const outcome = world.outcome<Standing | { standing?: Standing }>();
  expect(typeof outcome === 'string' ? outcome : outcome.standing).toBe(
    expected as Standing
  );
});
Then('every change reports {string}', (world, expected: string) => {
  world.outcome();
  const { series } = seen(world);
  expect(series.length).toBeGreaterThan(0);
  for (const stood of series) expect(stood).toBe(expected as Standing);
});
Then(
  /^the refresh reports "([^"]+)" and (a replaced|an unchanged) copy$/,
  (world, expected: string, copy: string) => {
    expect(world.outcome<Refreshed>()).toEqual({
      standing: expected as Standing,
      replaced: copy === 'a replaced',
    });
  }
);
Then('its copy was replaced', (world) => {
  expect(world.outcome<Refreshed>().replaced).toBe(true);
});
Then(
  phrase('a refresh of ', WHO, ' reports "([^"]+)"'),
  async (world, name: string | undefined, expected: string) => {
    expect((await refresh(world.manager(name).context)).standing).toBe(
      expected as Standing
    );
  }
);
Then(
  phrase(WHO, ' stands "([^"]+)" with the bucket'),
  async (world, name: string | undefined, expected: string) => {
    expect(await standing(world.manager(name).context)).toBe(
      expected as Standing
    );
  }
);
Then(
  phrase(WHO, ' has (changes|nothing) waiting for the bucket'),
  (world, name: string | undefined, what: string) => {
    expect(pending(world.manager(name).context)).toBe(what === 'changes');
  }
);
Then(
  'the change started from a copy that stood {string}',
  (world, expected: string) => {
    expect(seen(world).before?.standing).toBe(expected as Standing);
  }
);
Then(
  'the change started from the configuration {string}',
  (world, text: string) => {
    expect(seen(world).before?.configuration).toBe(text);
  }
);

Then(
  phrase(WHO, ' keeps no download and no lock in its state directory'),
  (world, name: string | undefined) => {
    const { root } = world.manager(name);
    expect(
      readdirSync(root).filter((entry) => entry.startsWith('incoming-'))
    ).toEqual([]);
    expect(existsSync(join(root, 'sync.lock'))).toBe(false);
  }
);

// ── What a manager without Litestream ran ────────────────────────────────

Then(/^(only )?"([^"]+)" was run$/, (world, only: string | undefined, line) => {
  const command = (line as string).split(' ');
  if (only) expect(seen(world).commands).toEqual([command]);
  else expect(seen(world).commands).toContainEqual(command);
});
