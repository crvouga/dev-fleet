import type { ConfigurationRequest } from '../../../src/configure';
import type { FleetDefinition } from '../../../src/definition';
import type { ManagerReport } from '../../../src/manager-sync';
import type { BootstrapPayload } from '../../../src/remote-bootstrap';
import type { RepairStep, RepairTarget } from '../../../src/repair-plan';
import type { TailnetComputer } from '../../../src/tailscale';
import type {
  Capability,
  Check,
  CommandResult,
  Fingerprint,
  FleetNode,
  NodeReport,
  Runner,
  Snapshot,
  Status,
} from '../../../src/types';
import { Commands } from '../../support/commands';
import { World, steps, type DataTable } from '../../support/gherkin';

/** One scenario of orchestration: the situation the `Given` steps describe,
 * and what the one `When` step produced for the `Then` steps to read.
 */
export class OrchestrationWorld extends World {
  /** Every subprocess is answered here; nothing real runs unless a step says
   * so in its own words.
   */
  readonly commands = new Commands();
  /** Written to the error output of every answer that has none of its own. */
  noise = '';
  readonly run: Runner = async (command, options) => {
    const result = await this.commands.run(command, options);
    return this.noise && !result.stderr
      ? { ...result, stderr: this.noise }
      : result;
  };

  // ── The situation ──────────────────────────────────────────────────────
  /** The checkout or directory the scenario is about. */
  root: string | undefined;
  /** The workers the manager has registered. */
  nodes: FleetNode[] = [];
  computers: TailnetComputer[] = [];
  /** A fingerprint taken earlier in the scenario. */
  reference: Fingerprint | undefined;
  probe: {
    source?: string;
    /** Preparing the source throws this instead of returning it. */
    error?: string;
    preparations: number;
  } = { preparations: 0 };

  // ── What happened ──────────────────────────────────────────────────────
  /** Everything the `When` step returned, as it would be printed. */
  outcome: unknown;
  /** The checks of an outcome that is about one checkout or one worker. */
  checks: Check[] = [];
  /** The reports of an outcome that is about several computers. */
  reports: NodeReport[] = [];
  /** A process that really ran. */
  process: CommandResult | undefined;
  fingerprint: Fingerprint | undefined;
  snapshot: Snapshot | undefined;
  /** What a rule answered about one value. */
  verdict: boolean | undefined;

  sync: {
    definition?: FleetDefinition;
    revision?: string;
    /** What deploying a worker reports, or the error it throws. */
    checks: Check[];
    /** What deploying one named worker reports, instead of `checks`. */
    byWorker: Record<string, Check[]>;
    error?: string;
    deployed: { worker: string; revision: string }[];
    finished: string[];
    report?: ManagerReport;
    /** When each parked worker was parked. */
    parked: Record<string, string>;
  } = { checks: [], byWorker: {}, deployed: [], finished: [], parked: {} };

  health: { excludedMobile: number; checks: Check[] } = {
    excludedMobile: 0,
    checks: [],
  };

  repair: {
    /** The checks the computer under repair reported. */
    reported: Check[];
    node?: string;
    snapshot?: Snapshot;
    targets: RepairTarget[];
    steps: RepairStep[];
  } = { reported: [], targets: [], steps: [] };

  bootstrap: {
    payload?: BootstrapPayload;
    /** What each SSH session answers, in the order they are opened. */
    sessions: CommandResult[];
  } = { sessions: [] };

  bundle: {
    directory?: string;
    source?: string;
    target?: string;
    file?: string;
    revision?: string;
    payload?: BootstrapPayload | null;
    fetched?: boolean;
    checkedOut?: boolean;
  } = {};

  cli: {
    /** Every file of the directory as it was before the command ran. */
    before: Map<string, string>;
  } = { before: new Map() };

  configuration: {
    request?: ConfigurationRequest;
    receipt?: string | null;
  } = {};
}

export const orchestration = steps<OrchestrationWorld>();

/** A value an earlier step must have set. */
export function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null)
    throw new Error(`No earlier step gave ${what}.`);
  return value;
}

export function cell(row: Record<string, string>, column: string): string {
  const value = row[column];
  if (value === undefined)
    throw new Error(`The table has no column "${column}".`);
  return value;
}

/** A column a table may leave out. */
export const optional = (row: Record<string, string>, column: string): string =>
  row[column] ?? '';

export const list = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Checks written as a table: id, status, summary and, where the check has
 * one, its remedy and the command the remedy names.
 */
export function checksIn(table: DataTable): Check[] {
  return table.hashes().map((row) => {
    const action = optional(row, 'remedy');
    const command = optional(row, 'remedy command');
    return {
      id: cell(row, 'id'),
      status: cell(row, 'status') as Status,
      summary: cell(row, 'summary'),
      ...(action
        ? { remedy: { action, ...(command ? { command } : {}) } }
        : {}),
    };
  });
}

/** `ssh -G alias`: the client resolving an alias, which contacts nothing. */
export const isResolution = (command: string[]): boolean =>
  command[0] === 'ssh' && command.includes('-G');
/** An SSH session opened to another computer. */
export const isSession = (command: string[]): boolean =>
  command[0] === 'ssh' && !command.includes('-G');

export function sessions(
  world: OrchestrationWorld
): OrchestrationWorld['commands']['calls'] {
  return world.commands.calls.filter((call) => isSession(call.command));
}

export function reportOf(world: OrchestrationWorld, node: string): NodeReport {
  return need(
    world.reports.find((report) => report.node === node),
    `a report of "${node}"`
  );
}

export const capabilities = (text: string): Capability[] =>
  list(text) as Capability[];
