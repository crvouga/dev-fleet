import { expect } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installedDefinition,
  parseDefinition,
  type FleetDefinition,
} from '../../../src/definition';
import {
  bucketIdentity,
  describeBucket,
  parseBucket,
  parseLocation,
  readBucket,
  writeBucket,
  type Bucket,
} from '../../../src/state/bucket';
import {
  connection,
  resolveConnection,
  type Connection,
} from '../../../src/state/connection';
import {
  litestreamConfig,
  litestreamEnvironment,
} from '../../../src/state/litestream';
import type { DataTable } from '../../support/gherkin';
import { expectPrivate } from './common';
import {
  EXAMPLE_FILE,
  REPOSITORY,
  WHO,
  json,
  phrase,
  scratch,
  state,
} from './world';

const { Given, When, Then } = state;

const settings = scratch<{
  /** As written, before they are read. */
  written: unknown;
  /** What the fleet configuration names. */
  declared: Bucket | null;
  /** What `fleet-state --init` saved on the manager. */
  saved: Bucket | null;
}>(() => ({ written: undefined, declared: null, saved: null }));

// ── Bucket settings ──────────────────────────────────────────────────────

Given('these bucket settings:', (world, table: DataTable) => {
  settings(world).written = table.rowsHash();
});
Given(/^the bucket settings are (.+)$/, (world, text: string) => {
  settings(world).written = json(text);
});

When('the settings are read', (world) =>
  world.attempt(() => parseBucket(settings(world).written))
);

Then('the bucket is exactly:', (world, table: DataTable) => {
  expect(world.outcome<Bucket>()).toEqual(table.rowsHash() as never);
});
Then('the bucket includes:', (world, table: DataTable) => {
  expect(world.outcome<Bucket>()).toMatchObject(table.rowsHash());
});

const described = (world: { outcome<T>(): T }, what: string): string => {
  const bucket = world.outcome<Bucket>();
  if (what === 'the description of the bucket')
    return JSON.stringify(describeBucket(bucket));
  if (what === 'the identity of the bucket') return bucketIdentity(bucket);
  const database = /"([^"]+)"/.exec(what)![1]!;
  return litestreamConfig(database, bucket);
};

Then(
  /^(the description of the bucket|the identity of the bucket|the Litestream configuration of "[^"]+") contains neither "([^"]+)" nor "([^"]+)"$/,
  (world, what: string, first: string, second: string) => {
    const text = described(world, what);
    expect(text).not.toContain(first);
    expect(text).not.toContain(second);
  }
);

Then(
  'the Litestream configuration of {string} contains each of:',
  (world, database: string, table: DataTable) => {
    const config = litestreamConfig(database, world.outcome<Bucket>());
    for (const line of table.list()) expect(config).toContain(line);
  }
);

Then('Litestream is handed exactly this environment:', (world, table) => {
  expect(litestreamEnvironment(world.outcome<Bucket>())).toEqual(
    (table as DataTable).rowsHash()
  );
});
Then('Litestream is handed no environment of its own', (world) => {
  expect(litestreamEnvironment(world.outcome<Bucket>())).toEqual({});
});
Then('a manager with no bucket is described as:', (_world, text: string) => {
  expect(describeBucket(null)).toEqual(json(text) as never);
});

// ── bucket.json ──────────────────────────────────────────────────────────

Given(
  phrase('the settings (?:are|were) saved on ', WHO),
  (world, name: string | undefined) => {
    writeBucket(
      world.manager(name).bucketFile,
      parseBucket(settings(world).written)
    );
  }
);

Given(
  phrase(WHO, ' saved these bucket settings:'),
  (world, name: string | undefined, table: DataTable) => {
    const manager = world.manager(name);
    const saved = parseBucket(table.rowsHash());
    settings(world).saved = saved;
    writeBucket(manager.bucketFile, saved);
  }
);

Given(
  phrase('the bucket\\.json of ', WHO, ' was made readable by others'),
  (world, name: string | undefined) => {
    chmodSync(world.manager(name).bucketFile, 0o644);
  }
);
Given(
  phrase('the bucket\\.json of ', WHO, ' was overwritten with "([^"]*)"'),
  (world, name: string | undefined, text: string) => {
    writeFileSync(world.manager(name).bucketFile, text);
  }
);

When(
  phrase('the saved bucket of ', WHO, ' is read'),
  (world, name: string | undefined) =>
    world.attempt(() => readBucket(world.manager(name).bucketFile))
);

Then(phrase(WHO, ' has no saved bucket'), (world, name: string | undefined) => {
  expect(readBucket(world.manager(name).bucketFile)).toBeNull();
});
Then(phrase(WHO, ' has no bucket\\.json'), (world, name?: string) => {
  expect(existsSync(world.manager(name).bucketFile)).toBe(false);
});
Then(
  phrase('the saved bucket of ', WHO, ' is exactly:'),
  (world, name: string | undefined, table: DataTable) => {
    expect(readBucket(world.manager(name).bucketFile)).toEqual(
      table.rowsHash() as never
    );
  }
);
Then(
  phrase('the bucket\\.json of ', WHO, ' is readable by its owner only'),
  (world, name: string | undefined) => {
    expectPrivate(world.manager(name).bucketFile);
  }
);
Then(
  phrase('the bucket\\.json of ', WHO, ' includes:'),
  (world, name: string | undefined, text: string) => {
    expect(
      json(readFileSync(world.manager(name).bucketFile, 'utf8'))
    ).toMatchObject(json(text) as object);
  }
);
Then(
  phrase('the bucket\\.json of ', WHO, ' contains "([^"]*)"'),
  (world, name: string | undefined, text: string) => {
    expect(readFileSync(world.manager(name).bucketFile, 'utf8')).toContain(
      text
    );
  }
);

// ── The connection ───────────────────────────────────────────────────────

Given(
  'the fleet configuration names the bucket:',
  (world, table: DataTable) => {
    settings(world).declared = parseLocation(table.rowsHash());
  }
);

When('the connection is resolved', (world) =>
  world.attempt(() =>
    resolveConnection(
      settings(world).declared,
      settings(world).saved,
      world.manager().env
    )
  )
);

When(
  phrase('a command on ', WHO, ' resolves its connection'),
  (world, name: string | undefined) => {
    const manager = world.manager(name);
    return world.attempt(() => connection(manager.env, manager.home));
  }
);

Then('the connection is exactly:', (world, text: string) => {
  expect(world.outcome<Connection>()).toEqual(json(text) as never);
});
Then('the connection includes:', (world, text: string) => {
  expect(world.outcome<Connection>()).toMatchObject(json(text) as object);
});
Then(
  'the credentials of the connection are {string}',
  (world, from: string) => {
    expect(world.outcome<Connection>().credentials).toBe(from as never);
  }
);
Then('the location of the connection is {string}', (world, from: string) => {
  expect(world.outcome<Connection>().location).toBe(from as never);
});
Then('the bucket of the connection has no {string}', (world, key: string) => {
  expect(world.outcome<Connection>().bucket).not.toHaveProperty(key);
});
Then('the connection has no bucket', (world) => {
  expect(world.outcome<Connection>().bucket).toBeNull();
});
Then('the connection does not contain {string}', (world, text: string) => {
  expect(JSON.stringify(world.outcome<Connection>())).not.toContain(text);
});

// ── The bucket a fleet.json names ────────────────────────────────────────

const tracked = (): Record<string, unknown> =>
  json(readFileSync(EXAMPLE_FILE, 'utf8')) as Record<string, unknown>;

When('the example fleet.json is read', (world) =>
  world.attempt(() => parseDefinition(tracked()))
);
When(/^the example fleet\.json is read with the bucket (.+)$/, (world, text) =>
  world.attempt(() =>
    parseDefinition({ ...tracked(), state: json(text as string) })
  )
);
Then(/^it names the bucket (.+)$/, (world, text: string) => {
  expect(world.outcome<FleetDefinition>().state).toEqual(json(text) as never);
});

Then(
  'the schema of fleet.json accepts a bucket written with exactly these settings:',
  (_world, table: DataTable) => {
    const schema = json(
      readFileSync(join(REPOSITORY, 'schema/fleet.schema.json'), 'utf8')
    ) as { properties: Record<string, { oneOf?: { properties: object }[] }> };
    const shapes = schema.properties['state']!.oneOf!.map((shape) =>
      Object.keys(shape.properties)
    );
    expect(shapes).toEqual(table.list().map((row) => row.split(', ')));
  }
);

interface Installed {
  definition: FleetDefinition;
  copy: Record<string, unknown>;
}

When('the example fleet.json is prepared for installing on machines', (world) =>
  world.attempt((): Installed => {
    const definition = parseDefinition(tracked());
    return {
      definition,
      copy: json(installedDefinition(definition)) as Record<string, unknown>,
    };
  })
);
Then('the installed copy has no {string}', (world, key: string) => {
  expect(world.outcome<Installed>().copy).not.toHaveProperty(key);
});
Then(
  'the installed copy is otherwise the configuration that was read',
  (world) => {
    const { definition, copy } = world.outcome<Installed>();
    const { state: _bucket, ...rest } = definition;
    expect(copy).toEqual(rest);
  }
);
Then('the installed copy is read back with the same workers', (world) => {
  const { definition, copy } = world.outcome<Installed>();
  expect(parseDefinition(copy).workers).toEqual(definition.workers);
});
