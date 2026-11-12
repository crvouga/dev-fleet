import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replicaCheck } from '../../../src/state/check';
import {
  SCHEMA_VERSION,
  migrations,
  readHead,
  readLease,
} from '../../../src/state/store';
import { pullAt, type Standing } from '../../../src/state/sync';
import type { Check } from '../../../src/types';
import { STATE, TEXT, phrase, scratch, state, type StateWorld } from './world';

const { Given, When, Then } = state;

// ── The schema version ───────────────────────────────────────────────────

const userVersion = (file: string): number => {
  const db = new Database(file, { readwrite: true, create: false });
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number })
      .user_version;
  } finally {
    db.close();
  }
};

const setVersion = (file: string, version: number): void => {
  const db = new Database(file, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
};

Then('the state migrations are numbered from 1 without a gap', () => {
  const found = migrations().map((migration) => migration.version);
  expect(found.length).toBeGreaterThan(0);
  expect(found).toEqual(found.map((_, index) => index + 1));
});
Then(
  'the schema version this dev-fleet writes is that of the last migration',
  () => {
    expect(SCHEMA_VERSION).toBe(migrations().at(-1)!.version);
  }
);
Then(
  'the state database has the schema version this dev-fleet writes',
  (world) => {
    expect(userVersion(world.manager().database)).toBe(SCHEMA_VERSION);
  }
);

/** The schema of the first released fleet state, which set no version. */
const UNVERSIONED = `
CREATE TABLE documents (name TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE head (one INTEGER PRIMARY KEY CHECK (one = 1), id TEXT NOT NULL, sequence INTEGER NOT NULL, written_at TEXT NOT NULL) STRICT;
`;

Given(
  phrase(
    'the state database was written by a dev-fleet without a schema version, holding the configuration ',
    TEXT
  ),
  (world, double?: string, single?: string) => {
    const manager = world.manager();
    mkdirSync(dirname(manager.database), { recursive: true });
    const db = new Database(manager.database, { create: true });
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(UNVERSIONED);
      db.query(
        "INSERT INTO documents VALUES ('definition', ?1, '2026-01-01T00:00:00.000Z')"
      ).run(double ?? single ?? '');
      db.exec(
        "INSERT INTO head VALUES (1, 'unversioned', 1, '2026-01-01T00:00:00.000Z')"
      );
    } finally {
      db.close();
    }
  }
);

const before = scratch<{ bytes?: string }>(() => ({}));

Given(
  'the state database was given the schema version {int}',
  (world, version: number) => {
    setVersion(world.manager().database, version);
    before(world).bytes = readFileSync(world.manager().database, 'base64');
  }
);
Then('the state database is byte for byte what it was', (world) => {
  expect(readFileSync(world.manager().database, 'base64')).toBe(
    before(world).bytes!
  );
});
Given(
  'the fleet state in the bucket was given the schema version {int}',
  (world, version: number) => {
    setVersion(join(world.remote, 'fleet.db'), version);
  }
);

// ── A damaged replica ────────────────────────────────────────────────────

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

Given('the time was noted', async (world) => {
  await pause(5);
  world.noted = new Date().toISOString();
  await pause(5);
});
Given('a second passed', () => pause(1_100));
Given('the bucket was emptied', (world) => {
  rmSync(world.remote, { recursive: true, force: true });
});
Given("the bucket's latest version was cut short", (world) => {
  world.litestream.truncate();
});

When(
  'manager {string} restores the version the bucket held at the noted time',
  (world, name: string) =>
    world.attempt(() => pullAt(world.manager(name).context, world.noted!))
);

const reported = scratch<{ check?: Check }>(() => ({}));

When('the standing {string} is reported as a check', (world, standing) => {
  reported(world).check = replicaCheck(standing as Standing);
});
Then('the check {string} fails', (world, id: string) => {
  expect(reported(world).check).toMatchObject({ id, status: 'fail' });
});
Then('its summary contains {string}', (world, text: string) => {
  expect(reported(world).check!.summary).toContain(text);
});
Then('its remedy contains {string}', (world, text: string) => {
  expect(reported(world).check!.remedy?.action).toContain(text);
});

// ── The manager lease ────────────────────────────────────────────────────

Given(
  'managers {string} and {string} are told apart by the manager lease',
  (world, first: string, second: string) => {
    for (const name of [first, second]) world.manager(name).holder = name;
  }
);
Given(
  'the clock of manager {string} is {int} days ahead',
  (world, name: string, days: number) => {
    world.manager(name).clock = new Date(Date.now() + days * 86_400_000);
  }
);
Given(
  'manager {string} takes over the manager lease',
  (world, name: string) => {
    world.manager(name).takeOver = true;
  }
);

const lease = (world: StateWorld, name: string | undefined) =>
  readLease(world.manager(name).database);

Then(
  phrase(STATE, ' names "([^"]+)" in the manager lease'),
  (world, name: string | undefined, holder: string) => {
    expect(lease(world, name)?.holder).toBe(holder);
  }
);
Then(
  phrase(STATE, ' has no manager lease'),
  (world, name: string | undefined) => {
    expect(lease(world, name)).toBeNull();
  }
);
Then(
  'the lease of manager {string} expires {int} days after its change',
  (world, name: string, days: number) => {
    const found = lease(world, name)!;
    const written = Date.parse(
      readHead(world.manager(name).database)!.writtenAt
    );
    const span = Date.parse(found.expiresAt) - written;
    expect(Math.abs(span - days * 86_400_000)).toBeLessThan(60_000);
  }
);

// ── A replacement manager ────────────────────────────────────────────────

Given(
  'manager {string} is a clean Mac named {string} with Git, Tailscale and Docker',
  (world, name: string, hostName: string) => {
    const litestream = world.litestream.run;
    const answer = (stdout: string) => ({
      ok: true,
      stdout,
      stderr: '',
      reason: 'exit' as const,
    });
    world.manager(name).run = async (argv, options) => {
      if (argv[0] === 'scutil') return answer(`${hostName}\n`);
      if (argv[0] === 'git') return answer('git version 2.50.0\n');
      if (argv[0] === 'tailscale')
        return answer('{"BackendState": "Running"}\n');
      if (argv[0] === 'docker') return answer('Docker Desktop\n');
      return litestream(argv, options);
    };
  }
);
