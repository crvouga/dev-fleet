import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import type {
  NotificationKind,
  NotifierCapability,
  NotifierTestResult,
  Platform,
  ProcessInfo,
  ScheduledJob,
  ScheduledJobStatus,
} from './types';
import { existsSync } from 'node:fs';

export class WindowsPlatform implements Platform {
  readonly name = 'windows' as const;
  readonly label = 'Windows';

  opencodeDir(): string {
    const base =
      process.env['APPDATA']?.trim() || join(homedir(), 'AppData/Roaming');
    return join(base, 'opencode');
  }

  cacheDir(): string {
    const base =
      process.env['LOCALAPPDATA']?.trim() || join(homedir(), 'AppData/Local');
    return join(base, 'opencode-cache');
  }

  globalBinDir(): string {
    return join(homedir(), '.local/bin');
  }

  canBuildSwiftNotifier(): boolean {
    return false;
  }

  shellRcFiles(): readonly string[] {
    return [];
  }

  notifierCapabilities(): NotifierCapability {
    return {
      native: true,
      sounds: false,
      clickToFocus: false,
      reason:
        'Windows uses a PowerShell toast fallback (no sounds, no click-to-focus); the macOS OpenCodeNotifier app is macOS-only.',
    };
  }

  async postNotification(input: {
    title: string;
    message: string;
    kind: NotificationKind;
  }): Promise<NotifierTestResult> {
    void input.kind;
    try {
      const ps = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `New-BurntToastNotification -Text ${JSON.stringify(input.title)}, ${JSON.stringify(input.message)}`,
      ];
      execFileSync('powershell', ps, { stdio: 'ignore' });
      return { ok: true, detail: 'posted via BurntToast' };
    } catch {
      // Fall through to msg.exe.
    }
    const r = spawnSync('msg', ['*', `${input.title}: ${input.message}`], {
      stdio: 'ignore',
    });
    if (r.status === 0) return { ok: true, detail: 'posted via msg' };
    return {
      ok: false,
      detail:
        'no notifier found (install BurntToast: Install-Module BurntToast)',
    };
  }

  isNotifierDaemonRunning(): boolean {
    return false;
  }

  restartNotifierDaemon(): void {
    // No daemon on Windows — no-op.
  }

  availableSystemSounds(): string[] {
    return [];
  }

  async playSystemSound(name: string): Promise<NotifierTestResult> {
    void name;
    return {
      ok: false,
      detail: 'sounds unsupported on Windows (toast fallback has no sound API)',
    };
  }

  listProcesses(): ProcessInfo[] | null {
    return null;
  }

  tailscaleAppBinaries(): readonly string[] {
    return ['C:\\Program Files\\Tailscale\\tailscale.exe'].filter((p) =>
      existsSync(p)
    );
  }

  vscodeSettingsPath(): string | null {
    const base =
      process.env['APPDATA']?.trim() || join(homedir(), 'AppData/Roaming');
    return join(base, 'Code/User/settings.json');
  }

  vscodeCliBinaries(): readonly string[] {
    const base =
      process.env['LOCALAPPDATA']?.trim() || join(homedir(), 'AppData/Local');
    return [join(base, 'Programs/Microsoft VS Code/bin/code.cmd')].filter((p) =>
      existsSync(p)
    );
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
