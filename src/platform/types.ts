/**
 * Platform abstraction for the `personal` CLI.
 *
 * Every OS-specific behavior lives behind this interface so the commands stay
 * platform-agnostic. Concrete adapters (darwin / linux / windows) implement
 * the same contract via polymorphism; `getPlatform()` is the factory.
 */

export type PlatformName = 'darwin' | 'linux' | 'windows' | 'unknown';

export type NotificationKind =
  'finished' | 'interrupted' | 'question' | 'permission' | 'error';

export type NotifierCapability = {
  /** Native rich notifications (click actions where supported). */
  readonly native: boolean;
  /** Per-kind sounds. */
  readonly sounds: boolean;
  /** Click-to-focus a project window/tab. */
  readonly clickToFocus: boolean;
  /** Human reason when a capability is unavailable. */
  readonly reason?: string;
};

export type NotifierTestResult = {
  readonly ok: boolean;
  readonly detail: string;
};

export type GlobalInstallResult = {
  readonly binDir: string;
  readonly launcherPath: string;
  readonly created: boolean;
  readonly alreadyOnPath: boolean;
};

/** One row of the OS process table (see `listProcesses`). */
export type ProcessInfo = {
  readonly pid: number;
  readonly ppid: number;
  /** Process group (a shell pipeline / job shares one). */
  readonly pgid: number;
  readonly uid: number;
  /** Resident memory in KiB. */
  readonly rssKb: number;
  /** Recent CPU percent (may exceed 100 on multi-core). */
  readonly cpu: number;
  /** `ps` state flags; a leading `Z` marks a zombie. */
  readonly state: string;
  /** Full command line (executable + args). */
  readonly command: string;
};

/** A periodic background job (launchd agent, systemd user timer, …). */
export type ScheduledJob = {
  readonly label: string;
  /** Absolute executable + args. */
  readonly command: readonly string[];
  readonly intervalSeconds: number;
  /** Directory for the job's stdout/stderr logs. */
  readonly logDir: string;
  /** Extra environment (e.g. PATH so `bun` resolves outside a login shell). */
  readonly env: Readonly<Record<string, string>>;
};

export type ScheduledJobStatus = {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly detail: string;
};

export type Platform = {
  /** Optional source-owned native Docker installer. */
  readonly dockerSetupScript?: string;
  readonly name: PlatformName;
  readonly label: string;

  /** `~/.config/opencode` (or the OS equivalent). */
  opencodeDir(): string;
  /** `~/.cache` (or the OS equivalent) — daemon sockets live here. */
  cacheDir(): string;
  /** Preferred global bin dir (`~/.local/bin` or Windows equivalent). */
  globalBinDir(): string;

  /** Whether `swiftc` builds / shell shims apply on this platform. */
  canBuildSwiftNotifier(): boolean;
  /** Shell RC files to inspect when ensuring `~/.local/bin` is on PATH. */
  shellRcFiles(): readonly string[];

  notifierCapabilities(): NotifierCapability;
  /** Best-effort desktop notification. Never throws — returns a result. */
  postNotification(input: {
    title: string;
    message: string;
    kind: NotificationKind;
  }): Promise<NotifierTestResult>;

  /** Daemon process running? (best-effort, always safe when unknown). */
  isNotifierDaemonRunning(): boolean;
  /** Best-effort daemon restart (kill so the next `--post` relaunches). */
  restartNotifierDaemon(): void;

  /** System sound names available for per-kind configuration (sorted, unique). */
  availableSystemSounds(): string[];
  /** Preview a system sound by name. Never throws — returns a result. */
  playSystemSound(name: string): Promise<NotifierTestResult>;

  /** Snapshot of every process, or `null` when unsupported on this OS. */
  listProcesses(): ProcessInfo[] | null;

  /** App-bundled Tailscale CLI binaries that exist (used when `tailscale` is not on PATH). */
  tailscaleAppBinaries(): readonly string[];
  /** VS Code user `settings.json`, or `null` when unknown on this OS. */
  vscodeSettingsPath(): string | null;
  /** VS Code `code` CLI binaries shipped inside the installed app. */
  vscodeCliBinaries(): readonly string[];

  /** Install (or replace) a periodic job. Never throws — returns a result. */
  installScheduledJob(job: ScheduledJob): NotifierTestResult;
  /** Remove a periodic job. Never throws — returns a result. */
  removeScheduledJob(label: string): NotifierTestResult;
  scheduledJobStatus(label: string): ScheduledJobStatus;
};
