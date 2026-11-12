import type { Runner } from '../types';

/** What kind of machine a worker is. A virtual machine has no lid, no
 * battery and no firmware its guest can read, and restarting it after a
 * power loss is its provider's job: checks of those are not applicable to
 * it. Containers and WSL2 are not workers at all (docs/support-matrix.md).
 */
export type MachineClass = 'physical' | 'virtual' | 'unsupported';

/** What systemd-detect-virt prints for a container or WSL rather than a
 * hypervisor. */
const CONTAINERS = [
  'container-other',
  'docker',
  'lxc',
  'lxc-libvirt',
  'openvz',
  'podman',
  'pouch',
  'proot',
  'rkt',
  'systemd-nspawn',
  'wsl',
];

/** The class of a machine from the probe's environment word (`machine`,
 * `container` or `wsl`) and what systemd-detect-virt printed: `none` is bare
 * metal, a hypervisor (`kvm`, `qemu`, `amazon`, `microsoft`, ...) a virtual
 * machine. When it cannot tell (`unknown`, or nothing), the machine is
 * taken as physical, so no check that applies to one is left out.
 */
export function machineClass(
  environment: string,
  virtualization: string
): MachineClass {
  if (environment !== 'machine' || CONTAINERS.includes(virtualization))
    return 'unsupported';
  return ['', 'none', 'unknown'].includes(virtualization)
    ? 'physical'
    : 'virtual';
}

/** The class of the machine this runs on, and the hypervisor, measured by
 * systemd-detect-virt. The worker's own checks use it; the manager's probe
 * records it for each worker before anything is installed. */
export async function detectMachineClass(
  run: Runner
): Promise<{ machine: MachineClass; virtualization: string }> {
  const detected = await run(['systemd-detect-virt']);
  const word = detected.stdout.trim();
  const virtualization = /^[a-z0-9-]{1,32}$/.test(word) ? word : 'unknown';
  return {
    machine: machineClass(
      CONTAINERS.includes(virtualization) ? 'container' : 'machine',
      virtualization
    ),
    virtualization,
  };
}
