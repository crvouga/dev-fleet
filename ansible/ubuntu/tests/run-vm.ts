/**
 * Runs the disposable Ubuntu VM test (vm.py) in one command, the way the VM
 * workflow runs it before every release. Needs Linux amd64 with Docker, KVM
 * and about 20 GiB free under ~/.cache.
 *
 *   bun ansible/ubuntu/tests/run-vm.ts baseline   # baseline, repeat, drift, agent, reboot
 *   bun ansible/ubuntu/tests/run-vm.ts bootstrap  # the production SSH bootstrap of HEAD, then a repeat
 *
 * The evidence stays in the directory it prints; keep it private.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MODES = ['baseline', 'bootstrap'] as const;
type Mode = (typeof MODES)[number];

const root = resolve(import.meta.dir, '../../..');
const image = 'personal-fleet-test-tools';

function must(command: string[], capture = false): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`${command.slice(0, 3).join(' ')} failed.`);
  return capture ? result.stdout : '';
}

export function run(mode: Mode): number {
  const cache = join(homedir(), '.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, `fleet-vm-${mode}.`));
  for (const part of ['vm', 'source', 'verification'])
    mkdirSync(join(directory, part));
  console.log(`VM evidence: ${directory}`);
  must(['docker', 'build', '-t', image, 'ansible/ubuntu/tests']);
  const mounts = [
    `${root}:/workspace:ro`,
    `${join(directory, 'vm')}:/artifacts`,
    `${join(directory, 'verification')}:/verification:ro`,
  ];
  if (mode === 'bootstrap') {
    // The commit under test, as fleet-sync sends it: never uncommitted edits.
    const source = join(directory, 'source');
    writeFileSync(
      join(source, 'revision'),
      must(['git', 'rev-parse', 'HEAD'], true)
    );
    must(['git', 'bundle', 'create', join(source, 'source.bundle'), 'HEAD']);
    writeFileSync(
      join(source, 'bootstrap.sh'),
      must(['git', 'show', 'HEAD:bootstrap/fleet-remote-bootstrap.sh'], true)
    );
    mounts.push(`${source}:/bootstrap:ro`);
  }
  must([
    'bun',
    'build',
    `ansible/ubuntu/tests/${mode === 'bootstrap' ? 'bootstrap-check' : 'runtime-check'}.ts`,
    '--compile',
    '--outfile',
    join(
      directory,
      'verification',
      mode === 'bootstrap' ? 'bootstrap' : 'verify'
    ),
  ]);
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--device',
      '/dev/kvm',
      ...mounts.flatMap((mount) => ['-v', mount]),
      image,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  return result.status ?? 1;
}

if (import.meta.main) {
  const mode = process.argv[2] as Mode;
  if (!MODES.includes(mode)) {
    console.error(
      `Usage: bun ansible/ubuntu/tests/run-vm.ts ${MODES.join('|')}`
    );
    process.exit(2);
  }
  process.exit(run(mode));
}
