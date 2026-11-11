import { expect, test } from 'bun:test';
import { verifyUbuntuBoot } from './ubuntu-verify';
import type { Runner } from '../types';
const result = (stdout: string, ok = true) => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});
const observed: Runner = async (args) => {
  if (args[0] === 'busctl') {
    if (args.at(-1) === 'StopIdleSessionUSec')
      return result('t 18446744073709551615');
    return result(
      args.at(-1) === 'KillUserProcesses' ? 'b false' : 's "ignore"'
    );
  }
  if (args[0] === 'systemctl') return result('masked', false);
  if (args[0] === 'loginctl') return result('yes');
  if (args[0] === 'cat') return result('cpu 1 2 3\nbtime 2000\n');
  if (args[0] === 'stat') return result('1000');
  throw new Error('Unexpected mutation');
};
test('boot acceptance uses running policy and pre-boot files, not a receipt', async () => {
  const checks = await verifyUbuntuBoot('fixture', observed);
  expect(checks[0]?.status).toBe('pass');
});
test('newly staged policy cannot claim reboot survival', async () => {
  const checks = await verifyUbuntuBoot('fixture', async (args, options) =>
    args[0] === 'stat' ? result('3000') : observed(args, options)
  );
  expect(checks[0]?.summary).toBe('UBUNTU_MAINTENANCE_REBOOT_PENDING');
});
test('a running login manager with old policy requires maintenance without restarting it', async () => {
  const checks = await verifyUbuntuBoot('fixture', async (args, options) =>
    args.at(-1) === 'HandleLidSwitch'
      ? result('s "suspend"')
      : observed(args, options)
  );
  expect(checks[0]?.summary).toBe('UBUNTU_SESSION_POLICY_PENDING');
});
test('an unmasked transition is observed as drift even after a prior successful apply', async () => {
  const checks = await verifyUbuntuBoot('fixture', async (args, options) =>
    args[0] === 'systemctl' ? result('static') : observed(args, options)
  );
  expect(checks[0]?.summary).toBe('UBUNTU_SLEEP_POLICY_DRIFT');
});
