import { expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseDefinition } from '../../../src/definition';
import {
  listDocuments,
  readDocument,
  readHead,
  writeDocument,
  type Head,
} from '../../../src/state/store';
import type { DataTable } from '../../support/gherkin';
import {
  DOCUMENT,
  EXAMPLE,
  STATE,
  TEXT,
  WHO,
  act,
  documentName,
  json,
  phrase,
  scratch,
  state,
  type Manager,
  type StateWorld,
} from './world';

const { Given, When, Then } = state;

// ── What a step was refused with ─────────────────────────────────────────

Then('it is refused with {string}', (world, message: string) => {
  const refusal = world.refused();
  expect(() => {
    throw refusal;
  }).toThrow(message);
});

// ── What the commands on a manager are passed ────────────────────────────

Given(
  phrase('commands on ', WHO, ' are passed:'),
  (world, name: string | undefined, table: DataTable) => {
    const manager = world.manager(name);
    manager.env = Object.fromEntries(
      Object.entries(table.rowsHash()).map(([variable, value]) => [
        variable,
        world.expand(value, manager),
      ])
    );
  }
);

// ── Files on a manager ───────────────────────────────────────────────────

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The example fleet as an object, to add a bucket to. */
export const exampleFleet = (): Record<string, unknown> =>
  json(readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;

const file = (world: StateWorld, path: string, name?: string): string => {
  const manager = world.manager(name);
  return world.expand(path, manager);
};

Given(
  phrase('"([^"]+)" on ', WHO, ' holds:'),
  (world, path: string, name: string | undefined, text: string) => {
    write(file(world, path, name), text);
  }
);

Given(
  phrase('"([^"]+)" on ', WHO, ' holds the example fleet'),
  (world, path: string, name: string | undefined) => {
    write(file(world, path, name), JSON.stringify(exampleFleet()));
  }
);

Given(
  phrase('"([^"]+)" on ', WHO, ' holds the example fleet with the bucket:'),
  (world, path: string, name: string | undefined, bucket: string) => {
    const manager = world.manager(name);
    write(
      world.expand(path, manager),
      JSON.stringify({
        ...exampleFleet(),
        state: json(world.expand(bucket, manager)),
      })
    );
  }
);

Given(
  phrase(
    '"([^"]+)" on ',
    WHO,
    ' holds the example fleet with "([^"]+)" renamed "([^"]+)"'
  ),
  (world, path: string, name: string | undefined, from: string, to: string) => {
    write(
      file(world, path, name),
      readFileSync(EXAMPLE, 'utf8').replaceAll(from, to)
    );
  }
);

Given(
  phrase('the directory "([^"]+)" exists on ', WHO),
  (world, path: string, name: string | undefined) => {
    mkdirSync(file(world, path, name), { recursive: true });
  }
);

Then(
  phrase('"([^"]+)" on ', WHO, ' still holds:'),
  (world, path: string, name: string | undefined, text: string) => {
    expect(readFileSync(file(world, path, name), 'utf8')).toBe(text);
  }
);

Then(
  phrase('"([^"]+)" on ', WHO, ' holds the example fleet, byte for byte'),
  (world, path: string, name: string | undefined) => {
    expect(readFileSync(file(world, path, name), 'utf8')).toBe(
      readFileSync(EXAMPLE, 'utf8')
    );
  }
);

Then(
  phrase(
    '"([^"]+)" on ',
    WHO,
    ' holds the example fleet as machines are sent it'
  ),
  (world, path: string, name: string | undefined) => {
    expect(json(readFileSync(file(world, path, name), 'utf8'))).toEqual(
      parseDefinition(exampleFleet())
    );
  }
);

/** No bit set for the group or for others. */
export const expectPrivate = (path: string): void => {
  expect(statSync(path).mode & 0o077).toBe(0);
};

Then(
  phrase('"([^"]+)" on ', WHO, ' is readable by its owner only'),
  (world, path: string, name: string | undefined) => {
    expectPrivate(file(world, path, name));
  }
);

// ── The bucket's stand-in ────────────────────────────────────────────────

Given(/^the bucket (?:stops|stopped) answering$/, (world) => {
  world.litestream.down = true;
});
Given(/^the bucket (?:answers|answered) again$/, (world) => {
  world.litestream.down = false;
});
Given(
  /^the bucket (?:reports|reported) uploads as stored without storing them$/,
  (world) => {
    world.litestream.lossy = true;
  }
);
Given(/^the bucket (?:stores|stored) uploads again$/, (world) => {
  world.litestream.lossy = false;
});

Then('Litestream was never started', (world) => {
  expect(world.litestream.calls).toHaveLength(0);
});
Then(/^Litestream was started(?: for the first bucket)?$/, (world) => {
  expect(world.litestream.calls.length).toBeGreaterThan(0);
});
Then('Litestream was started more than once', (world) => {
  expect(world.litestream.calls.length).toBeGreaterThan(1);
});
Then('no Litestream command line contains {string}', (world, text: string) => {
  for (const call of world.litestream.calls)
    expect(call.argv.join(' ')).not.toContain(text);
});
Then('every Litestream command is {string}', (world, binary: string) => {
  for (const call of world.litestream.calls) expect(call.argv[0]).toBe(binary);
});
Then(
  'every Litestream command line carries {string}',
  (world, flag: string) => {
    for (const call of world.litestream.calls)
      expect(call.argv).toContain(flag);
  }
);
Then(
  'every Litestream command has {string} set to {string} in its environment',
  (world, variable: string, value: string) => {
    for (const call of world.litestream.calls)
      expect(call.env[variable]).toBe(value);
  }
);
Then(
  'the last Litestream command had in its environment:',
  (world, table: DataTable) => {
    expect(world.litestream.calls.at(-1)!.env).toMatchObject(table.rowsHash());
  }
);

// ── The documents of a fleet state ───────────────────────────────────────

/** Every version a scenario stored, in order. */
const versions = scratch<Head[]>(() => []);

Given('a manager without a fleet state', (world) => {
  world.manager();
});

Given(
  phrase('the ', DOCUMENT, ' (is|was) stored as ', TEXT),
  (world, document: string, verb: string, double?: string, single?: string) =>
    act(world, verb, () => {
      const head = writeDocument(
        world.manager().database,
        documentName(document),
        double ?? single ?? ''
      );
      versions(world).push(head);
      return head;
    })
);

When(
  phrase('the ', DOCUMENT, ' is stored as (\\d+) characters'),
  (world, document: string, length: number) =>
    world.attempt(() =>
      writeDocument(
        world.manager().database,
        documentName(document),
        'x'.repeat(Number(length))
      )
    )
);

When(
  phrase('the ', DOCUMENT, ' is read from the fleet state'),
  (world, document: string) =>
    world.attempt(() =>
      readDocument(world.manager().database, documentName(document))
    )
);

Given(
  'the state database was overwritten with {string}',
  (world, text: string) => {
    writeFileSync(world.manager().database, text);
  }
);

Then('that is version {int} of the fleet state', (world, sequence: number) => {
  expect(world.outcome<Head>().sequence).toBe(sequence);
});
Then('its head is not the head before it', (world) => {
  expect(world.outcome<Head>().id).not.toBe(versions(world).at(-2)!.id);
});
Then('that is the version before it, unchanged', (world) => {
  expect(world.outcome<Head>()).toEqual(versions(world).at(-2)!);
});
Then('the head of the fleet state is that version', (world) => {
  expect(readHead(world.manager().database)).toEqual(world.outcome<Head>());
});
Then('the fleet state has no head', (world) => {
  expect(readHead(world.manager().database)).toBeNull();
});
Then('the fleet state lists no documents', (world) => {
  expect(listDocuments(world.manager().database)).toEqual([]);
});
Then('the fleet state lists these documents:', (world, table: DataTable) => {
  expect(
    listDocuments(world.manager().database).map((entry) => entry.name)
  ).toEqual(table.list() as never[]);
});
Then('no state database exists', (world) => {
  expect(existsSync(world.manager().database)).toBe(false);
});
Then('the state database is readable by its owner only', (world) => {
  expectPrivate(world.manager().database);
});

const stored = (manager: Manager, document: string): string | null =>
  readDocument(manager.database, documentName(document));

Then(
  phrase(STATE, ' holds no ', DOCUMENT),
  (world, name: string | undefined, document: string) => {
    expect(stored(world.manager(name), document)).toBeNull();
  }
);
Then(
  phrase(STATE, ' holds a ', DOCUMENT),
  (world, name: string | undefined, document: string) => {
    expect(stored(world.manager(name), document)).not.toBeNull();
  }
);
Then(
  phrase(STATE, ' holds the ', DOCUMENT, ' ', TEXT),
  (
    world,
    name: string | undefined,
    document: string,
    double?: string,
    single?: string
  ) => {
    expect(stored(world.manager(name), document)).toBe(double ?? single ?? '');
  }
);
Then(
  phrase(STATE, ' holds the ', DOCUMENT, ':'),
  (world, name: string | undefined, document: string, text: string) => {
    expect(stored(world.manager(name), document)).toBe(text);
  }
);
Then(
  phrase('the ', DOCUMENT, ' in ', STATE, ' contains "([^"]*)"'),
  (world, document: string, name: string | undefined, text: string) => {
    expect(stored(world.manager(name), document)).toContain(text);
  }
);
