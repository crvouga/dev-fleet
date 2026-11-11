import { Database } from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { CommandOptions, Runner } from '../../../src/types';

export interface FakeLitestream {
  run: Runner;
  /** Every command line and environment the code under test started. */
  calls: { argv: string[]; env: NodeJS.ProcessEnv }[];
  /** While true the bucket does not answer. */
  down: boolean;
  /** While true uploads report success without storing anything. */
  lossy: boolean;
}

const result = (ok: boolean) => ({
  ok,
  stdout: '',
  stderr: '',
  reason: 'exit' as const,
});

/** Stands in for the Litestream binary: `replicate` stores a consistent copy
 * of the database in `remote`, `restore` returns it. Enough to exercise how
 * the fleet state is compared, replaced and uploaded without a bucket.
 */
export function fakeLitestream(remote: string): FakeLitestream {
  const stored = join(remote, 'fleet.db');
  const fake: FakeLitestream = {
    calls: [],
    down: false,
    lossy: false,
    run: async (argv: string[], options: CommandOptions = {}) => {
      // Locating the pinned binary is not a call to the bucket.
      if (argv[0] === 'mise')
        return { ...result(true), stdout: '/pinned/litestream\n' };
      fake.calls.push({ argv, env: options.env ?? {} });
      if (fake.down) return result(false);
      const command = argv[1];
      const config = parse(
        readFileSync(argv[argv.indexOf('-config') + 1]!, 'utf8')
      ) as { dbs: [{ path: string }] };
      const database = config.dbs[0].path;
      if (command === 'replicate') {
        if (fake.lossy) return result(true);
        mkdirSync(dirname(stored), { recursive: true });
        rmSync(`${stored}.next`, { force: true });
        const db = new Database(database, { readwrite: true, create: false });
        try {
          db.exec(`VACUUM INTO '${stored}.next'`);
        } finally {
          db.close();
        }
        renameSync(`${stored}.next`, stored);
        return result(true);
      }
      if (command !== 'restore') return result(false);
      const output = argv[argv.indexOf('-o') + 1]!;
      if (existsSync(stored)) copyFileSync(stored, output);
      return result(true);
    },
  };
  return fake;
}
