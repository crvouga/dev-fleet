import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  NotificationKind,
  NotifierCapability,
  NotifierTestResult,
  Platform,
  ProcessInfo,
  ScheduledJob,
  ScheduledJobStatus,
} from './types';

/** Safe default for unrecognized platforms — filesystem converges, notify degrades. */
export class FallbackPlatform implements Platform {
  readonly name = 'unknown' as const;
  readonly label = 'Unknown';

  opencodeDir(): string {
    return join(homedir(), '.config/opencode');
  }

  cacheDir(): string {
    return join(homedir(), '.cache');
  }

  globalBinDir(): string {
    return join(homedir(), '.local/bin');
  }

  canBuildSwiftNotifier(): boolean {
    return false;
  }

  shellRcFiles(): readonly string[] {
    return [join(homedir(), '.profile')];
  }

  notifierCapabilities(): NotifierCapability {
    return {
      native: false,
      sounds: false,
      clickToFocus: false,
      reason: 'unrecognized platform — notifications disabled',
    };
  }

  async postNotification(_input: {
    title: string;
    message: string;
    kind: NotificationKind;
  }): Promise<NotifierTestResult> {
    return { ok: false, detail: 'notifications unsupported on this platform' };
  }

  isNotifierDaemonRunning(): boolean {
    return false;
  }

  restartNotifierDaemon(): void {
    // No-op.
  }

  availableSystemSounds(): string[] {
    return [];
  }

  async playSystemSound(name: string): Promise<NotifierTestResult> {
    void name;
    return { ok: false, detail: 'sounds unsupported on this platform' };
  }

  listProcesses(): ProcessInfo[] | null {
    return null;
  }

  tailscaleAppBinaries(): readonly string[] {
    return [];
  }

  installScheduledJob(job: ScheduledJob): NotifierTestResult {
    return {
      ok: false,
      detail: `scheduled jobs are not supported on ${this.label} (${job.label})`,
    };
  }

  removeScheduledJob(label: string): NotifierTestResult {
    return {
      ok: true,
      detail: `nothing to remove for ${label} on ${this.label}`,
    };
  }

  scheduledJobStatus(label: string): ScheduledJobStatus {
    return {
      supported: false,
      installed: false,
      detail: `not supported on ${this.label} (${label})`,
    };
  }
}
