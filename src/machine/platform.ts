import type { MachineDefinition } from '../definition';

export type MachinePlatform = MachineDefinition['os'];

/** One POSIX probe for every supported machine: family, release and CPU. */
export const PLATFORM_PROBE =
  'sh -c \'if [ "$(uname -s)" = Darwin ]; then printf "macos\\n%s\\n%s\\n" "$(sw_vers -productVersion)" "$(uname -m)"; else . /etc/os-release && printf "%s\\n%s\\n%s\\n" "$ID" "$VERSION_ID" "$(uname -m)"; fi\'';

export interface PlatformBaseline {
  id: 'ubuntu:release' | 'macos:release';
  supported: boolean;
  summary: string;
}

/** Ubuntu is the fully accepted worker platform; macOS is best effort. */
export function evaluatePlatform(
  os: MachinePlatform,
  probe: string
): PlatformBaseline {
  if (os === 'macOS') {
    const supported =
      /^macos\n(1[4-9]|[2-9][0-9])(\.[0-9]+)*\n(arm64|x86_64)\s*$/.test(probe);
    return {
      id: 'macos:release',
      supported,
      summary: supported
        ? 'macOS 14 or newer and a supported CPU architecture observed; macOS policy is best effort.'
        : 'MACOS_BASELINE_MISMATCH',
    };
  }
  const supported = /^ubuntu\n26\.04\n(x86_64|aarch64)\s*$/.test(probe);
  return {
    id: 'ubuntu:release',
    supported,
    summary: supported
      ? 'Ubuntu 26.04 and supported CPU architecture observed.'
      : 'UBUNTU_BASELINE_MISMATCH',
  };
}

/** Windows machines stay declared but never receive manager convergence. */
export function convergeable(node: MachineDefinition): boolean {
  return node.os !== 'windows';
}
