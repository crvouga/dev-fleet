import { record } from './config';
import type { Check, Runner } from './types';

/** Only recognize named firmware settings; an enabled OS service is not proof of AC recovery. */
export async function powerRecoveryCheck(run: Runner): Promise<Check> {
  const result = await run(
    ['sudo', '-n', 'fwupdmgr', 'get-bios-settings', '--json'],
    { timeoutMs: 15_000 }
  );
  try {
    const data: unknown = JSON.parse(result.stdout);
    const settings =
      record(data) && Array.isArray(data['BiosSettings'])
        ? data['BiosSettings']
        : [];
    const observed = settings.find(
      (item) =>
        record(item) &&
        [
          'RestoreACPowerLoss',
          'AfterPowerLoss',
          'PowerOnAfterPowerFail',
          'ACPowerRecovery',
        ].includes(String(item['Name']))
    );
    if (result.ok && record(observed)) {
      const enabled = ['Power On', 'Always On', 'PowerOn', 'On'].includes(
        String(observed['CurrentValue'])
      );
      return {
        id: 'worker:power-loss-recovery',
        status: enabled ? 'pass' : 'fail',
        summary: enabled
          ? 'Firmware reports an enabled restore-after-AC-loss setting; a real power-loss test remains distinct from configuration evidence.'
          : 'Firmware restore-after-AC-loss is disabled.',
        remedy: {
          action:
            'Enable the machine firmware restore-after-AC-loss setting or configure its VM host power recovery.',
        },
      };
    }
  } catch {
    /* Firmware output may contain hardware identifiers; never expose it. */
  }
  return {
    id: 'worker:power-loss-recovery',
    status: 'skip',
    summary:
      'Automatic power-on after AC loss is not observable through a supported firmware adapter on this machine.',
    remedy: {
      action:
        'Enable and test restore-on-AC-power in the firmware or VM host during initial enrollment. An OS unit cannot power on a switched-off machine.',
    },
  };
}
