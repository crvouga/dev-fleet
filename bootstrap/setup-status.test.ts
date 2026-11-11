import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupStatus, setupFailureCode } from './setup-status';

test('installer evidence is private, versioned and refuses symlink destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-status-'));
  try {
    const path = join(root, 'status.json');
    const report = setupStatus(path);
    report('t3', 'running');
    report('t3', 'failed');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      phase: 't3',
      status: 'failed',
    });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const other = join(root, 'untouched');
      writeFileSync(other, 'preserved');
      rmSync(path);
      symlinkSync(other, path);
      expect(() => report('mise', 'running')).toThrow('Unsafe setup status');
      expect(readFileSync(other, 'utf8')).toBe('preserved');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer diagnostics never serialize arbitrary exception messages', () => {
  expect(
    setupFailureCode(new Error('PRIVATE_SENTINEL token=value'))
  ).toBeUndefined();
  expect(
    setupFailureCode(new Error('Pinned T3 executable verification failed.'))
  ).toBe('T3_EXECUTABLE_FAILED');
});
