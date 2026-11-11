import { afterEach, expect, test } from 'bun:test';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databasePath } from '../../src/state/paths';
import {
  listDocuments,
  readDocument,
  readHead,
  writeDocument,
} from '../../src/state/store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function database(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-state-'));
  roots.push(root);
  return databasePath(join(root, 'state'));
}

test('reading a machine without state finds nothing and creates nothing', async () => {
  const file = await database();
  expect(readDocument(file, 'definition')).toBeNull();
  expect(readHead(file)).toBeNull();
  expect(listDocuments(file)).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

test('a document is stored privately and every change advances the head', async () => {
  const file = await database();
  const first = writeDocument(file, 'definition', '{"a":1}');
  expect(first.sequence).toBe(1);
  expect(statSync(file).mode & 0o077).toBe(0);
  expect(readDocument(file, 'definition')).toBe('{"a":1}');
  const second = writeDocument(file, 'roster', '{"b":2}');
  expect(second.sequence).toBe(2);
  expect(second.id).not.toBe(first.id);
  expect(readHead(file)).toEqual(second);
  expect(listDocuments(file).map((entry) => entry.name)).toEqual([
    'definition',
    'roster',
  ]);
});

test('storing the text already stored is not a new version', async () => {
  const file = await database();
  const first = writeDocument(file, 'enrollment', 'same');
  expect(writeDocument(file, 'enrollment', 'same')).toEqual(first);
  expect(readHead(file)).toEqual(first);
});

test('an oversized document and an unreadable database are refused with a remedy', async () => {
  const file = await database();
  expect(() =>
    writeDocument(file, 'definition', 'x'.repeat(1024 * 1024 + 1))
  ).toThrow('smaller than 1 MiB');
  writeDocument(file, 'definition', '{}');
  writeFileSync(file, 'not a database');
  expect(() => readDocument(file, 'definition')).toThrow(
    'fleet-state --restore'
  );
});
