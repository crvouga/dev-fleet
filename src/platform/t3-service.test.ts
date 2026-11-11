import { expect, test } from 'bun:test';
import { convergeT3Service } from './t3-service';
import type { Runner } from '../types';
const artifact = { path: '/managed/t3', version: '0.1.7' };
const result = (stdout: string, ok = true) => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});

/** Fake systemctl: `units` maps a unit to its active/enabled state. */
function fake(units: Record<string, { active: boolean; enabled: boolean }>) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    if (args.includes('--version')) return result('t3 v0.1.7');
    const [, , verb, unit = ''] = args;
    const state = units[unit] ?? { active: false, enabled: false };
    if (verb === 'start') state.active = true;
    if (verb === 'disable') state.enabled = false;
    if (verb === 'is-active') return result('', state.active);
    if (verb === 'is-enabled') return result('', state.enabled);
    return result('');
  };
  return { run, calls };
}

test('a running desktop app is checked without restart or pairing', async () => {
  const { run, calls } = fake({
    't3code-desktop.service': { active: true, enabled: true },
  });
  const checks = await convergeT3Service(artifact, run);
  expect(checks[0]?.status).toBe('pass');
  expect(
    calls.some((args) =>
      ['start', 'restart', 'stop', 'pair'].some((verb) => args.includes(verb))
    )
  ).toBe(false);
});
test('a different T3 launcher version is preserved instead of replaced', async () => {
  const calls: string[][] = [];
  const checks = await convergeT3Service(artifact, async (args) => {
    calls.push(args);
    return result('t3 v0.1.8');
  });
  expect(checks[0]?.summary).toBe('T3_EXECUTABLE_OWNER_CONFLICT');
  expect(calls).toHaveLength(1);
});
test('a conflicting launcher prevents policy staging and installation', async () => {
  let prepared = false;
  let installed = false;
  await convergeT3Service(
    artifact,
    async () => result('t3 v0.1.8'),
    async () => {
      prepared = true;
      return [];
    },
    async () => {
      installed = true;
      return true;
    }
  );
  expect(prepared).toBe(false);
  expect(installed).toBe(false);
});
test('a failed desktop installation is reported and nothing is started', async () => {
  const { run, calls } = fake({});
  const checks = await convergeT3Service(
    artifact,
    run,
    async () => [],
    async () => false
  );
  expect(checks[0]?.summary).toBe('T3_DESKTOP_INSTALL_FAILED');
  expect(calls.some((args) => args.includes('start'))).toBe(false);
});
test('the play owns every change: this only measures, it never runs systemctl verbs', async () => {
  const { run, calls } = fake({
    't3code.service': { active: false, enabled: true },
    't3code-desktop.service': { active: false, enabled: true },
  });
  const checks = await convergeT3Service(artifact, run);
  // Stopped after the play ran: reported, not started from here.
  expect(checks[0]?.summary).toBe('T3_DESKTOP_STOPPED');
  expect(
    calls.some((args) =>
      ['start', 'stop', 'disable', 'restart', 'reset-failed'].some((verb) =>
        args.includes(verb)
      )
    )
  ).toBe(false);
});
test('a desktop app that cannot start without a session is reported', async () => {
  const run: Runner = async (args) => {
    if (args.includes('--version')) return result('t3 v0.1.7');
    return result('', args[2] === 'is-enabled' && args[3] !== 't3code.service');
  };
  const checks = await convergeT3Service(artifact, run);
  expect(checks[0]?.summary).toBe('T3_DESKTOP_STOPPED');
});
