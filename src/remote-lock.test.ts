import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { remoteLockPrelude } from './remote-lock';

test('remote lock prelude parses as POSIX shell and prefers flock when present', () => {
  const prelude = remoteLockPrelude();
  expect(prelude).toContain('flock -n 9');
  expect(prelude).toContain('fcntl.LOCK_EX | fcntl.LOCK_NB');
  expect(spawnSync('sh', ['-n', '-c', prelude]).status).toBe(0);
});

test('tracked remote shell entry points parse on this host shell', () => {
  for (const script of [
    'bootstrap/fleet-remote-bootstrap.sh',
    'ansible/ubuntu/authorize-sudo.sh',
  ]) {
    const result = spawnSync('sh', ['-n', `${import.meta.dir}/../${script}`], {
      encoding: 'utf8',
    });
    expect(result.status, `${script}: ${result.stderr}`).toBe(0);
  }
});
