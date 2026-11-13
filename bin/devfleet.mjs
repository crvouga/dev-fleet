#!/usr/bin/env node
// The npm entry point: `npx @crvouga/dev-fleet <command>`. The CLI is TypeScript
// run by Bun, and Node refuses to run TypeScript from node_modules, so this
// plain-JavaScript launcher hands the arguments to Bun and nothing else.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url));

/** The first bytes of an ELF, Mach-O (thin or universal) or PE executable. */
const MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xca, 0xfe, 0xba, 0xbf],
  [0x4d, 0x5a],
];

/** Whether the file is a compiled executable rather than a text stub. Linux
 * runs a stub without a shebang through /bin/sh instead of failing to spawn
 * it, so the spawn error cannot tell the two apart.
 */
function isExecutable(path) {
  const head = Buffer.alloc(4);
  let read = 0;
  try {
    const fd = openSync(path, 'r');
    try {
      read = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return MAGIC.some(
    (magic) =>
      magic.length <= read && magic.every((byte, at) => head[at] === byte)
  );
}

/** The Bun this release pins (a dependency), then any Bun on PATH. The
 * dependency's binary is a stub when its install script was skipped, and is
 * passed over then. The one on PATH may be a version manager's script shim,
 * so it is only tried.
 */
function bunCandidates() {
  const candidates = ['bun'];
  try {
    const pinned = createRequire(import.meta.url).resolve('bun/bin/bun.exe');
    if (isExecutable(pinned)) candidates.unshift(pinned);
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
