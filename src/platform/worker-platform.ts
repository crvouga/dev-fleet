import type { Check, Runner } from '../types';
import type { WorkerFeatures } from '../worker-features';

/** One release of a worker platform, as its policy names it. */
export interface WorkerRelease {
  /** `VERSION_ID` of /etc/os-release. */
  release: string;
  codename: string;
  /** Debian architecture names, as `dpkg --print-architecture` reports them. */
  architectures: string[];
}

/** What differs between the operating systems a worker may run. Everything
 * the manager and the worker's own checks need to know about one platform is
 * here; what a playbook needs is data of the platform's policy, selected on
 * the machine from its facts. Ubuntu is the one implementation
 * (`src/platform/ubuntu-worker.ts`); docs/support-matrix.md lists the
 * platforms that are not, and what each would need.
 */
export interface WorkerPlatform {
  /** `ID` of /etc/os-release, as the platform probe prints it. */
  readonly family: string;
  /** The name the support matrix gives it. */
  readonly label: string;
  /** The policy that names its releases and pins, from the package root. */
  readonly policy: string;
  /** The playbooks that converge it, from the package root. */
  readonly playbooks: string;
  /** The releases a worker may run, newest first. */
  readonly releases: readonly WorkerRelease[];
  /** The reason a machine of this family is refused before anything is
   * installed: another release or another CPU. */
  readonly mismatch: string;

  /** Packages: the system package manager the pins are written for, and the
   * exact pins of one release (common pins with the release's own over them). */
  readonly packageManager: 'apt';
  packagePins(release: WorkerRelease | undefined): Record<string, string>;
  /** The libraries headless Chromium loads, pinned the same way. */
  browserPackagePins(
    release: WorkerRelease | undefined
  ): Record<string, string>;
  /** The Tailscale version and the digest of the key that signs this
   * release's package suite. */
  tailscalePins(release: WorkerRelease | undefined): {
    version: string;
    keySha256: string;
  };

  /** Service manager: what keeps the always-on system services and the
   * developer's own units running and restarts them. */
  readonly serviceManager: 'systemd';
  /** Session model: how the developer's processes (T3, agents) outlive a
   * login. `systemd-user-linger`: a lingering systemd user manager, started
   * at boot without anyone logged in, never stopped by logind. */
  readonly sessionModel: 'systemd-user-linger';

  /** The release a probe reported, when the platform accepts it. */
  release(version: string | null | undefined): WorkerRelease | undefined;
  /** The `uname -m` names one release runs on. */
  kernelArchitectures(release: WorkerRelease): string[];
  /** Checks: the measured host evidence of a worker of this platform,
   * read-only, run on the worker itself. What its declared features leave
   * out is not applicable; so is a physical machine's power recovery on a
   * virtual one, which `powerRecoveryNote` may say who provides. */
  hostChecks(
    user: string,
    run: Runner,
    features?: WorkerFeatures,
    powerRecoveryNote?: string
  ): Promise<Check[]>;
}
