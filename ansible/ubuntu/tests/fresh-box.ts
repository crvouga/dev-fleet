/** Opt-in fresh-box acceptance; never invoked by unit tests (it downloads the
 * whole worker toolchain). Runs the production worker bootstrap, exactly as
 * fleet-sync sends it, against a disposable Ubuntu container that has only a
 * sudo-capable user. Run: bun ansible/ubuntu/tests/fresh-box.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bootstrapRemote,
  prepareBootstrap,
} from '../../../src/remote-bootstrap';
import { loadDefinition } from '../../../src/definition';
import { runCommand } from '../../../src/runner';
import type { Check, Runner } from '../../../src/types';

const repo = resolve(import.meta.dir, '../../..');
const image = 'dev-fleet-fresh-box';
const container = `fleet-fresh-box-${process.pid}`;
const node = {
  id: 'fresh-box',
  ssh: 'fresh-box',
  workspace: '/unused',
  required: [],
};

async function must(args: string[], timeoutMs = 600_000): Promise<string> {
  const result = await runCommand(args, { cwd: repo, timeoutMs });
  if (!result.ok) throw new Error(`${args.slice(0, 3).join(' ')} failed`);
  return result.stdout.trim();
}

/** The production transport, with the SSH hop replaced by `docker exec`: the
 * remote command and its stdin are passed through untouched.
 */
const transport: Runner = (args, options) =>
  runCommand(
    args[0] === 'ssh'
      ? ['docker', 'exec', '-i', container, 'sh', '-c', args.at(-1)!]
      : args,
    options
  );

/** Reaching node convergence proves the box needed nothing beforehand: source
 * transfer, OS prerequisites, the locked toolchain and frozen dependencies.
 * Node checks themselves need systemd, a desktop session and live accounts,
 * which a container does not have; they are printed, not asserted.
 */
function bootstrapped(checks: Check[]): boolean {
  return (
    checks.length > 0 &&
    !checks.some((check) => check.id.startsWith('bootstrap:'))
  );
}

function report(title: string, checks: Check[], started: number): void {
  console.log(`\n${title} (${Math.round((Date.now() - started) / 1000)}s)`);
  for (const check of checks)
    console.log(`  ${check.status.padEnd(4)} ${check.id}  ${check.summary}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'fleet-fresh-box-'));
let failed = false;
try {
  const revision = await must(['git', 'rev-parse', 'HEAD']);
  if (await must(['git', 'status', '--porcelain']))
    console.log('Note: uncommitted edits are not part of the tested revision.');
  await must([
    'docker',
    'build',
    '-q',
    '-t',
    image,
    '-f',
    'ansible/ubuntu/tests/fresh-box.Dockerfile',
    'ansible/ubuntu/tests',
  ]);
  await must(['docker', 'run', '-d', '--rm', '--name', container, image]);
  for (const tool of ['git', 'curl', 'python3', 'mise', 'bun', 'node'])
    if ((await transport(['ssh', `command -v ${tool}`])).ok)
      throw new Error(`The fresh box already has ${tool}.`);
  const payload = await prepareBootstrap(scratch, revision, runCommand, {
    checkout: repo,
    // The example fleet: the box receives its configuration like any worker.
    definition: loadDefinition(resolve(repo, 'examples/fleet.json')),
  });
  if (!payload) throw new Error('The approved source could not be bundled.');

  let started = Date.now();
  const first = await bootstrapRemote(node, payload, transport);
  report('Fresh box', first.checks, started);
  started = Date.now();
  const second = await bootstrapRemote(node, payload, transport);
  report(
    'Same box again (cached source, warm toolchain)',
    second.checks,
    started
  );
  const repeat = Date.now() - started;

  const installed = await transport([
    'ssh',
    `cd "$HOME/.local/share/personal/fleet/revisions/${revision}" && test -d node_modules && test "$(git rev-list --count HEAD)" = 1 && "$HOME/.local/bin/mise" exec --locked bun -- bun --version`,
  ]);
  // A brand-new agent worktree with its own mise.toml must not need `mise trust`.
  const worktree = await transport([
    'ssh',
    'w="$HOME/.t3/worktrees/fresh-box/check" && mkdir -p "$w" && printf \'[env]\\nFRESH_BOX = "1"\\n\' > "$w/mise.toml" && cd "$w" && "$HOME/.local/bin/mise" which claude >/dev/null',
  ]);
  const configured = await transport([
    'ssh',
    'test -s "$HOME/.config/dev-fleet/fleet.json"',
  ]);
  failed =
    !bootstrapped(first.checks) ||
    !bootstrapped(second.checks) ||
    !installed.ok ||
    !worktree.ok ||
    !configured.ok ||
    repeat > 120_000;
  console.log(
    failed
      ? '\nFAIL: the fresh box did not reach node convergence.'
      : `\nPASS: a box with only sudo reached node convergence at ${revision.slice(0, 12)}; the repeat took ${Math.round(repeat / 1000)}s.`
  );
} finally {
  // --keep leaves the box running for inspection (docker exec -it NAME sh).
  if (process.argv.includes('--keep')) console.log(`Kept ${container}.`);
  else await runCommand(['docker', 'rm', '-f', container]);
  await rm(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
