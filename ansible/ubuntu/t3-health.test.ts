import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 't3-health.sh');

/** Runs the watchdog with fake systemctl/curl that record what was called. */
function fixture(active: boolean, healthy: boolean, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 't3-health-'));
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  const fake = (name: string, body: string) => {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`
    );
    chmodSync(join(dir, name), 0o755);
  };
  fake(
    'systemctl',
    `case "$*" in *"is-active --quiet t3code.service") exit ${legacy ? 0 : 3};; *is-active*) exit ${active ? 0 : 3};; esac`
  );
  fake('curl', `exit ${healthy ? 0 : 28}`);
  const run = () =>
    Bun.spawnSync(['/bin/sh', script], {
      env: { PATH: `${dir}:/usr/bin:/bin`, XDG_RUNTIME_DIR: dir },
    }).exitCode;
  const calls = () => readFileSync(log, 'utf8');
  return { run, calls };
}

test('a stopped service is started', () => {
  const t3 = fixture(false, false);
  expect(t3.run()).toBe(0);
  expect(t3.calls()).toContain('systemctl --user start t3code-desktop.service');
});
test('a healthy service is left alone', () => {
  const t3 = fixture(true, true);
  t3.run();
  expect(t3.calls()).not.toMatch(/start|restart/);
});
test('an unresponsive service is restarted only after three failed checks', () => {
  const t3 = fixture(true, false);
  t3.run();
  t3.run();
  expect(t3.calls()).not.toContain('restart');
  t3.run();
  expect(t3.calls()).toContain(
    'systemctl --user restart t3code-desktop.service'
  );
});
test('nothing is started while the headless server still runs', () => {
  const t3 = fixture(false, false, true);
  expect(t3.run()).toBe(0);
  expect(t3.calls()).not.toMatch(/ (start|restart) /);
});
