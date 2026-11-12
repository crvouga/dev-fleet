import { Database } from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
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
  /** Cuts the bucket's latest version short, as a damaged replica. */
  truncate(): void;
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
  // Every version uploaded, named by the time it was: what a restore to an
  // earlier time reads.
  const history = join(remote, 'history');
  const versions = (): string[] =>
    existsSync(history) ? readdirSync(history).sort() : [];
  const fake: FakeLitestream = {
    calls: [],
    down: false,
    lossy: false,
    truncate() {
      const text = readFileSync(stored);
      const cut = text.subarray(0, Math.floor(text.length / 3));
      writeFileSync(stored, cut);
      const latest = versions().at(-1);
      if (latest) writeFileSync(join(history, latest), cut);
    },
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
        mkdirSync(history, { recursive: true });
        copyFileSync(
          stored,
          join(history, `${String(Date.now()).padStart(15, '0')}.db`)
        );
        return result(true);
      }
      if (command !== 'restore') return result(false);
      const output = argv[argv.indexOf('-o') + 1]!;
      const at = argv.indexOf('-timestamp');
      if (at < 0) {
        if (existsSync(stored)) copyFileSync(stored, output);
        return result(true);
      }
      const until = Date.parse(argv[at + 1]!);
      const version = versions()
        .filter((name) => Number(name.slice(0, 15)) <= until)
        .at(-1);
      if (version) copyFileSync(join(history, version), output);
      return result(true);
    },
  };
  return fake;
}
