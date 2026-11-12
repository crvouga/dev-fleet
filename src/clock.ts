import policy from '../ansible/ubuntu/policy.json';
import type { HealthSample } from './machine-health';
import type { Check } from './types';

const { warnOffsetSeconds, failOffsetSeconds } = policy.clock;

/** A skewed clock breaks TLS, token validation, apt signatures and Vault
 * logins with errors that never mention time. The clock passes when it is
 * synchronised to a time source and, where a reference time was measured,
 * within the offset floors of `policy.json`.
 *
 * `offsetSeconds` is the difference to the reference (the manager's clock),
 * when one was measured.
 */
export function clockCheck(
  id: string,
  sample: Pick<HealthSample, 'clockSynced' | 'timeService'>,
  offsetSeconds?: number
): Check {
  const offset =
    offsetSeconds === undefined ? undefined : Math.abs(offsetSeconds);
  const measured =
    offset === undefined ? '' : `, ${offset.toFixed(1)} s from the manager`;
  const remedy = clockRemedy(sample.timeService);
  if (sample.clockSynced === undefined && offset === undefined)
    return {
      id,
      status: 'skip',
      summary: 'CLOCK_UNOBSERVED: the clock synchronisation could not be read.',
    };
  if (offset !== undefined && offset > failOffsetSeconds)
    return { id, status: 'fail', summary: `CLOCK_SKEWED${measured}`, remedy };
  if (sample.clockSynced === 0 && sample.timeService === 0)
    return {
      id,
      status: 'fail',
      summary: `CLOCK_NOT_SYNCHRONISED: no time service is enabled${measured}`,
      remedy,
    };
  if (sample.clockSynced === 0)
    return {
      id,
      status: 'warn',
      summary: `CLOCK_NOT_SYNCHRONISED${measured}`,
      remedy,
    };
  if (offset !== undefined && offset > warnOffsetSeconds)
    return { id, status: 'warn', summary: `CLOCK_DRIFTING${measured}`, remedy };
  return {
    id,
    status: 'pass',
    summary: `The clock is synchronised to a time source${measured}.`,
  };
}

/** The offset of a worker's clock from the manager's, measured by the
 * manager around one SSH round trip: the worker read its clock between
 * `sentAt` and `receivedAt` (milliseconds on the manager's clock), so the
 * offset is only known to lie in that window. The check judges the smallest
 * offset the window allows, so a slow link never reads as a skewed clock.
 */
export function clockOffsetCheck(
  remoteSeconds: number,
  sentAt: number,
  receivedAt: number
): Check {
  const remote = remoteSeconds * 1000;
  const least =
    remote > receivedAt
      ? (remote - receivedAt) / 1000
      : remote < sentAt
        ? (sentAt - remote) / 1000
        : 0;
  const direction = remote > receivedAt ? 'ahead of' : 'behind';
  const measured = `${least.toFixed(1)} s ${direction} the manager`;
  const remedy = clockRemedy(undefined);
  if (least > failOffsetSeconds)
    return {
      id: 'worker:clock-offset',
      status: 'fail',
      summary: `CLOCK_SKEWED ${measured}`,
      remedy,
    };
  if (least > warnOffsetSeconds)
    return {
      id: 'worker:clock-offset',
      status: 'warn',
      summary: `CLOCK_DRIFTING ${measured}`,
      remedy,
    };
  return {
    id: 'worker:clock-offset',
    status: 'pass',
    summary: `The clock is within ${warnOffsetSeconds} s of the manager's.`,
  };
}

function clockRemedy(timeService: number | undefined): { action: string } {
  return {
    action:
      timeService === 0
        ? 'Enable the time service: apply the approved fleet-sync revision, which keeps chrony or systemd-timesyncd enabled on workers (timedatectl set-ntp true is the same setting).'
        : 'Check that the time service reaches a time server (timedatectl timesync-status) and that UDP port 123 is not blocked.',
  };
}
