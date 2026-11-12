import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetUsageError } from '../errors';

/** Everything the manager must not lose, as one JSON text each:
 * `definition` is the fleet configuration (fleet.json), `roster` the enrolled
 * connection to each worker, `enrollment` the approved and applied revision.
 */
export const DOCUMENTS = ['definition', 'roster', 'enrollment'] as const;
/** Kept when there is something to keep; a fleet without them is complete:
 * `history` is the record of recent fleet-sync runs and of the schedule.
 */
export const OPTIONAL_DOCUMENTS = ['history'] as const;
export type DocumentName = (typeof DOCUMENTS)[number];
/** Every document the fleet state may hold. */
export type StoredName = DocumentName | (typeof OPTIONAL_DOCUMENTS)[number];
const KNOWN: readonly string[] = [...DOCUMENTS, ...OPTIONAL_DOCUMENTS];

/** One version of the whole database. Every change replaces it, so two copies
 * hold the same state exactly when their heads are equal.
 */
export interface Head {
  id: string;
  sequence: number;
  writtenAt: string;
}

export interface DocumentInfo {
  name: StoredName;
  bytes: number;
  updatedAt: string;
}

const MAX_DOCUMENT_BYTES = 1024 * 1024;

export interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('./migrations/', import.meta.url)
);

/** The schema as numbered files (`0001-documents.sql`, …), applied in order.
 * A database records the last one it received in `PRAGMA user_version`; one
 * written before the schema had a version holds exactly the first.
 */
export function migrations(directory = MIGRATIONS_DIRECTORY): Migration[] {
  return readdirSync(directory)
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name, index) => {
      const version = Number(name.slice(0, 4));
      if (version !== index + 1)
        throw new Error(`State migrations must be numbered from 1: ${name}`);
      return { version, sql: readFileSync(join(directory, name), 'utf8') };
    });
}

const MIGRATIONS = migrations();

/** The schema version this dev-fleet writes and the newest it can read. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A fleet state written by a newer dev-fleet: this one must neither read nor
 * change it, or a rollback (or an old second manager) would damage it.
 */
export class StateNewerError extends FleetUsageError {}

function schemaVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

/** Refuses a database a newer dev-fleet wrote; returns its version. */
function supported(db: Database): number {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION)
    throw new StateNewerError(
      `FLEET_STATE_NEWER_THAN_CLI: the fleet state has schema version ${version}, and this dev-fleet reads version ${SCHEMA_VERSION} at most. Nothing was read or changed. Install the dev-fleet version the fleet runs (npx devfleet --version on the manager that wrote it) and run the command again.`
    );
  return version;
}

/** Brings a database forward to `SCHEMA_VERSION`, one migration at a time. */
function migrate(db: Database): void {
  const from = supported(db);
  for (const migration of MIGRATIONS.filter((entry) => entry.version > from)) {
    db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}

function unreadable(): FleetUsageError {
  return new FleetUsageError(
    'The fleet state database cannot be read. It is a local copy: run devfleet fleet-state --restore to replace it from the bucket.'
  );
}

/** Reads never create the database: a machine without one has no state.
 * The connection is still opened for writing, because a WAL database that
 * was just downloaded has no shared-memory file yet and a read-only
 * connection may not create one.
 */
function reading<T>(file: string, read: (db: Database) => T): T | null {
  if (!existsSync(file)) return null;
  let db: Database | undefined;
  try {
    db = new Database(file, { readwrite: true, create: false });
    supported(db);
    return read(db);
  } catch (error) {
    if (error instanceof FleetUsageError) throw error;
    throw unreadable();
  } finally {
    db?.close();
  }
}

/** Litestream replicates the write-ahead log, so the database stays in WAL
 * mode; a second devfleet process waits for the first instead of failing.
 */
function writing<T>(file: string, write: (db: Database) => T): T {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let db: Database | undefined;
  try {
    db = new Database(file, { create: true, readwrite: true });
    chmodSync(file, 0o600);
    // Checked before anything is written, the journal mode included.
    supported(db);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const opened = db;
    return opened
      .transaction(() => {
        migrate(opened);
        return write(opened);
      })
      .immediate();
  } catch (error) {
    if (error instanceof FleetUsageError) throw error;
    throw new FleetUsageError(
      'The fleet state database cannot be written. Check the state directory permissions and free disk space.'
    );
  } finally {
    db?.close();
  }
}

function tables(db: Database): boolean {
  return (
    (
      db
        .query(
          "SELECT count(*) AS found FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'head')"
        )
        .get() as { found: number }
    ).found === 2
  );
}

export function readDocument(file: string, name: StoredName): string | null {
  return reading(file, (db) => {
    if (!tables(db)) return null;
    const row = db
      .query('SELECT body FROM documents WHERE name = ?1')
      .get(name) as { body: string } | null;
    return row?.body ?? null;
  });
}

export function listDocuments(file: string): DocumentInfo[] {
  return (
    reading(file, (db) => {
      if (!tables(db)) return [];
      const rows = db
        .query(
          'SELECT name, length(CAST(body AS BLOB)) AS bytes, updated_at AS updatedAt FROM documents ORDER BY name'
        )
        .all() as DocumentInfo[];
      return rows.filter((row) => KNOWN.includes(row.name));
    }) ?? []
  );
}

export function readHead(file: string): Head | null {
  return reading(file, (db) => {
    if (!tables(db)) return null;
    return db
      .query('SELECT id, sequence, written_at AS writtenAt FROM head')
      .get() as Head | null;
  });
}

function nextHead(db: Database): Head {
  const head = db
    .query('SELECT id, sequence, written_at AS writtenAt FROM head')
    .get() as Head | null;
  const next: Head = {
    id: randomUUID(),
    sequence: (head?.sequence ?? 0) + 1,
    writtenAt: new Date().toISOString(),
  };
  db.query(
    'INSERT INTO head (one, id, sequence, written_at) VALUES (1, ?1, ?2, ?3) ON CONFLICT (one) DO UPDATE SET id = ?1, sequence = ?2, written_at = ?3'
  ).run(next.id, next.sequence, next.writtenAt);
  return next;
}

/** Stores one document and advances the head. Writing the text already
 * stored changes nothing, so repeating a command never looks like new state.
 */
export function writeDocument(
  file: string,
  name: StoredName,
  body: string
): Head {
  if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES)
    throw new FleetUsageError(
      'A fleet state document must be smaller than 1 MiB.'
    );
  return writing(file, (db) => {
    const current = db
      .query('SELECT body FROM documents WHERE name = ?1')
      .get(name) as { body: string } | null;
    const head = db
      .query('SELECT id, sequence, written_at AS writtenAt FROM head')
      .get() as Head | null;
    if (head && current?.body === body) return head;
    const next = nextHead(db);
    db.query(
      'INSERT INTO documents (name, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET body = ?2, updated_at = ?3'
    ).run(name, body, next.writtenAt);
    return next;
  });
}

/** Which manager may change the fleet state, and until when. */
export interface Lease {
  holder: string;
  expiresAt: string;
}

export function readLease(file: string): Lease | null {
  return reading(file, (db) => {
    const present = db
      .query(
        "SELECT count(*) AS found FROM sqlite_master WHERE type = 'table' AND name = 'lease'"
      )
      .get() as { found: number };
    if (!present.found) return null;
    return db
      .query('SELECT holder, expires_at AS expiresAt FROM lease')
      .get() as Lease | null;
  });
}

/** Records the lease and advances the head, so that the bucket carries it. */
export function writeLease(file: string, lease: Lease): Head {
  return writing(file, (db) => {
    db.query(
      'INSERT INTO lease (one, holder, expires_at) VALUES (1, ?1, ?2) ON CONFLICT (one) DO UPDATE SET holder = ?1, expires_at = ?2'
    ).run(lease.holder, lease.expiresAt);
    return nextHead(db);
  });
}
