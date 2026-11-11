import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test.skipIf(process.platform !== 'linux')(
  'T3 integrity accepts a different release-builder UID but rejects content, mode and link drift',
  () => {
    const result = spawnSync(
      'python3',
      ['-B', join(import.meta.dir, 'test_verify_t3_archive.py')],
      {
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }
);
