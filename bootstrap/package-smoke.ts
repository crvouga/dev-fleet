/**
 * Installs a packed release the way a fleet project does and runs it, before
 * the Release workflow publishes that same tarball. A package whose `devfleet`
 * cannot start (a broken bin path, a file left out of `files`, a launcher that
 * fails on this Node) fails here, never on npm.
 *
 *   bun bootstrap/package-smoke.ts <tarball> <version> <commit>
 *
 * It runs in an empty directory, outside any project, so it reads no
 * fleet.json and contacts no machine.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Expected {
  version: string;
  /** The commit the release workflow stamped as `gitHead`. */
  commit: string;
}

function run(command: string[], cwd: string): Ran {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DEVFLEET_CONFIG: '' },
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function must(ran: Ran, what: string): string {
  if (ran.status !== 0)
    throw new Error(
      `${what} failed (exit ${ran.status ?? 'not started'}): ${ran.stderr.trim().split('\n').slice(-3).join(' ')}`
    );
  return ran.stdout;
}

/** Install the tarball in a new directory and run its `devfleet`. */
export function smoke(tarball: string, expected: Expected): void {
  const directory = mkdtempSync(join(tmpdir(), 'devfleet-smoke-'));
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'devfleet-smoke', private: true })
    );
    must(
      run(
        // Into the throwaway project only: nothing on the machine changes.
        [
          'npm',
          '--prefix',
          directory,
          'install',
          '--no-audit',
          '--no-fund',
          '--save-exact',
          resolve(tarball),
        ],
        directory
      ),
      'npm install'
    );
    const devfleet = join(directory, 'node_modules', '.bin', 'devfleet');
    const version = must(
      run([devfleet, '--version'], directory),
      'devfleet --version'
    );
    if (!version.includes(expected.version))
      throw new Error(
        `devfleet --version printed "${version.trim()}", not ${expected.version}.`
      );
    if (!version.includes(expected.commit.slice(0, 7)))
      throw new Error(
        `devfleet --version names no commit ${expected.commit.slice(0, 7)}.`
      );
    const example = must(
      run([devfleet, 'fleet-state', '--example'], directory),
      'devfleet fleet-state --example'
    );
    const parsed = JSON.parse(example) as { $schema?: unknown };
    if (typeof parsed.$schema !== 'string')
      throw new Error('The example fleet.json names no schema.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarball, version, commit] = process.argv.slice(2);
  if (!tarball || !version || !commit) {
    console.error(
      'Usage: bun bootstrap/package-smoke.ts <tarball> <version> <commit>'
    );
    process.exit(2);
  }
  smoke(tarball, { version, commit });
  console.log(`${tarball} installs and runs: devfleet ${version}`);
}
