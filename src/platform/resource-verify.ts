import policy from '../../ansible/ubuntu/policy.json';
import type { Check, Runner } from '../types';

const AGENT_DROP_IN =
  '/etc/systemd/user/t3code-.scope.d/60-personal-fleet.conf';
const GUARDS = [
  'systemd-oomd.service',
  'personal-fleet-disk-guard.service',
  'personal-fleet-disk-gc.timer',
];
const MIB = 1024 * 1024;
const FLOOR_MIB = policy.resourceSafety.diskGuardFloorMiB;

/** A failure code and remedy, or undefined when the probe passes. */
type Probe = (run: Runner) => Promise<[string, string] | undefined>;

const guardsRunning: Probe = async (run) => {
  for (const unit of GUARDS) {
    const active = await run(['systemctl', 'is-active', unit]);
    if (active.stdout.trim() !== 'active')
      return [
        'RESOURCE_GUARD_INACTIVE',
        `${unit} is not running. Reapply fleet-sync; runaway memory or disk use is unguarded until then.`,
      ];
  }
  return undefined;
};

const memoryReserved: Probe = async (run) => {
  const show = (property: string, unit: string) =>
    run(['systemctl', 'show', `--property=${property}`, '--', unit]);
  const user = await show('MemoryMax', 'user.slice');
  const root = await show('ManagedOOMSwap', '-.slice');
  const ok =
    /^MemoryMax=\d+$/m.test(user.stdout) &&
    /^ManagedOOMSwap=kill$/m.test(root.stdout);
  return ok
    ? undefined
    : [
        'MEMORY_RESERVE_MISSING',
        'User workloads are not capped below physical memory, or swap exhaustion is unmanaged. Reapply fleet-sync.',
      ];
};

const agentsBounded: Probe = async (run) =>
  (await run(['test', '-f', AGENT_DROP_IN])).ok
    ? undefined
    : [
        'AGENT_MEMORY_LIMIT_MISSING',
        'T3 agent scopes have no per-agent memory limit. Reapply fleet-sync; new agents pick it up without restarts.',
      ];

const swapActive: Probe = async (run) => {
  // /proc/swaps, not swapon: /usr/sbin is not on the remote worker PATH.
  const swaps = await run(['cat', '/proc/swaps']);
  return swaps.ok && swaps.stdout.trim().split('\n').length > 1
    ? undefined
    : [
        'SWAP_MISSING',
        'No swap is active. Reapply fleet-sync with enough free disk for the swap file.',
      ];
};

const diskAboveFloor =
  (path: string): Probe =>
  async (run) => {
    const df = await run(['df', '--output=avail', '-B1', path]);
    const free = Number(df.stdout.trim().split('\n').at(-1));
    if (!df.ok || !Number.isSafeInteger(free))
      return ['DISK_FREE_UNREADABLE', `Free space on ${path} is unreadable.`];
    if (free >= FLOOR_MIB * MIB) return undefined;
    return [
      'DISK_FREE_BELOW_FLOOR',
      `${path} has ${Math.floor(free / MIB)} MiB free, under the ${FLOOR_MIB} MiB floor. The disk GC already removed idle build output and caches; remove stale worktrees or data, or run "sudo systemctl start personal-fleet-disk-gc.service" and read its journal.`,
    ];
  };

/** Free space cannot show this: /tmp is RAM-backed with a per-user quota, so a
 * write fails while the filesystem still reports room. Probe a real 1 MiB write.
 */
const tmpWritable: Probe = async (run) =>
  (
    await run([
      'sh',
      '-c',
      'f=$(mktemp /tmp/personal-fleet-probe.XXXXXX) || exit 1; head -c 1048576 /dev/zero >"$f"; s=$?; rm -f -- "$f"; exit "$s"',
    ])
  ).ok
    ? undefined
    : [
        'TMP_QUOTA_EXHAUSTED',
        'This user cannot write to /tmp (full, or its per-user quota is used up), so agents and builds fail. The guard never deletes files; remove stale caches and scratch directories under /tmp.',
      ];

/** Measured memory and disk safety on an Ubuntu worker: the running managers,
 * not the files Ansible wrote. Free space below the guard floor fails because
 * what is left after the disk GC is work a person must decide about.
 */
export async function verifyResourceSafety(
  home: string,
  run: Runner
): Promise<Check[]> {
  const probes = [
    guardsRunning,
    memoryReserved,
    agentsBounded,
    swapActive,
    diskAboveFloor('/'),
    diskAboveFloor(home),
    tmpWritable,
  ];
  for (const probe of probes) {
    const failure = await probe(run);
    if (failure)
      return [
        {
          id: 'ubuntu:resource-safety',
          status: 'fail',
          summary: failure[0],
          remedy: { action: failure[1] },
        },
      ];
  }
  return [
    {
      id: 'ubuntu:resource-safety',
      status: 'pass',
      summary:
        'systemd-oomd, the disk guard and the disk GC timer are running, user workloads are capped below physical memory, T3 agents have per-agent limits, swap is active, free disk is above the guard floor and /tmp is writable.',
    },
  ];
}
