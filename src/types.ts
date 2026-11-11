export type Status = 'pass' | 'warn' | 'fail' | 'skip';
export type Capability =
  | 'github'
  | 'vault'
  | 't3'
  | 'vscode'
  | 'toolchain'
  | 'codex'
  | 'claude'
  | 'services'
  | 'workstation'
  | 'worker';

export interface FleetNode {
  id: string;
  ssh: string;
  workspace: string;
  tailscaleId?: string;
  t3EnvironmentId?: string;
  bootstrapViaSsh?: boolean;
  runtime?: string;
  required: Capability[];
}

export interface FleetConfig {
  version: 1;
  nodes: FleetNode[];
}

export interface Check {
  /** Explicitly out-of-scope checks do not affect required readiness. */
  required?: boolean;
  /** Measured enclosing phase duration; omitted when not observed. */
  phaseDurationMs?: number;
  id: string;
  status: Status;
  summary: string;
  remedy?: { action: string; command?: string };
}

/** Only a required failure blocks readiness. Warnings (conditions outside the
 * fleet, such as a provider quota) and skips (not observable here) are shown
 * but never fail a run.
 */
export function blocking(check: Check): boolean {
  return check.status === 'fail' && check.required !== false;
}

export interface Fingerprint {
  head: string | null;
  files: Record<string, string | null>;
}

export interface Snapshot {
  version: 1;
  platform: string;
  fingerprint: Fingerprint;
  checks: Check[];
}

export interface NodeReport {
  node: string;
  checks: Check[];
  snapshot?: Snapshot;
}

export interface Report {
  version: 1;
  command: string;
  ok: boolean;
  generatedAt: string;
  nodes: NodeReport[];
  summary: Record<Status, number>;
}

export interface CommandOptions {
  /** Internal remote worker: keep the already-held operation lock on fd 9. */
  preserveOperationLock?: boolean;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run with `env` alone instead of on top of this process's environment:
   * for a launch that must see only what a service would.
   */
  isolatedEnv?: boolean;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason: 'exit' | 'missing' | 'timeout' | 'overflow';
}

export type Runner = (
  command: string[],
  options?: CommandOptions
) => Promise<CommandResult>;
