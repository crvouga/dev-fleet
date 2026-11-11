#!/usr/bin/env node
// The npm entry point: `npx @crvouga/dev-fleet <command>`. The CLI is TypeScript
// run by Bun, and Node refuses to run TypeScript from node_modules, so this
// plain-JavaScript launcher hands the arguments to Bun and nothing else.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url));

/** The Bun this release pins (a dependency), then any Bun on PATH. The
 * dependency's binary is a stub when its install script was skipped.
 */
function bunCandidates() {
  const candidates = ['bun'];
  try {
    candidates.unshift(
      createRequire(import.meta.url).resolve('bun/bin/bun.exe')
    );
  } catch {
    // Not installed beside this package.
  }
  return candidates;
}

for (const bun of bunCandidates()) {
  const child = spawnSync(bun, [cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (!child.error) process.exit(child.status ?? 1);
}
process.stderr.write(
  'dev-fleet needs Bun and could not start it. Install it from https://bun.sh and retry.\n'
);
process.exit(127);
