import type { CommandOutcome } from './contracts';
import { showRepairs } from './ui-repairs';
import {
  callArgs,
  clean,
  text,
  isCancellation,
  record,
  reproduction,
  reportChecks,
} from './ui-data';
import type { Session } from './ui-types';

export async function execute(
  session: Session,
  args: string[],
  title: string
): Promise<CommandOutcome> {
  session.display.write(`\n$ ${reproduction(session, args)}`);
  const progress = session.display.progress(title);
  try {
    return await session.options.execute(callArgs(session, args));
  } catch (error) {
    if (isCancellation(error)) throw error;
    return { exitCode: 1, data: { ok: false, code: 'operation_failed' } };
  } finally {
    progress.stop();
  }
}

export function successful(outcome: CommandOutcome): boolean {
  return (
    outcome.exitCode === 0 &&
    !(record(outcome.data) && outcome.data['ok'] === false)
  );
}

export function showOutcome(session: Session, outcome: CommandOutcome): void {
  const checks = reportChecks(outcome.data);
  const incomplete = checks.filter((check) =>
    ['warn', 'skip'].includes(check.status)
  ).length;
  const state = outcomeState(outcome, incomplete);
  const counts = ['pass', 'warn', 'fail', 'skip'].map(
    (status) =>
      `${checks.filter((check) => check.status === status).length} ${status}`
  );
  session.display.panel(
    state,
    checks.length ? counts.join(' · ') : outcomeMessage(outcome)
  );
  showAttention(session, checks);
  showData(session, outcome);
  if (!successful(outcome))
    session.display.write(
      record(outcome.data) && outcome.data['applied'] === true
        ? 'Actions were attempted. Review execution results, partial changes and fresh checks before retrying.'
        : 'No automatic repair was attempted. Review the command, context and setup.'
    );
}

function outcomeMessage(outcome: CommandOutcome): string {
  if (!successful(outcome)) return failureMessage(outcome.data);
  if (record(outcome.data) && outcome.data['applied'] === false) {
    return 'Preview only — no changes applied. Review before explicitly authorizing a write.';
  }
  return 'Command completed. Warnings and skipped checks are not passes.';
}

function failureMessage(data: unknown): string {
  if (!record(data))
    return 'Operation failed. Raw errors and subprocess output are intentionally hidden.';
  if (data['code'] === 'invalid_usage' && typeof data['error'] === 'string')
    return clean(data['error']);
  const messages: Record<string, string> = {
    invalid_usage:
      'Configuration or arguments need attention. Run fleet-nodes --schema to check the roster, or pass --config.',
    config_missing:
      'No roster found. Run fleet-node-add, or run manager-only diagnostics with fleet-status --local.',
    operation_failed:
      'Operation failed safely. Check connectivity and configuration before retrying.',
  };
  return (
    messages[String(data['code'])] ??
    'Operation did not complete. Review setup and the noninteractive command.'
  );
}

function showNodes(session: Session, data: Record<string, unknown>): void {
  const nodes = Array.isArray(data['nodes'])
    ? data['nodes'].filter(record)
    : [];
  if (!nodes.length) {
    session.display.write(
      'No computers registered yet. Run fleet-node-add to add one, or fleet-discover to list Tailscale computers.'
    );
    return;
  }
  session.display.table(
    ['Computer', 'SSH', 'Workspace'],
    nodes.map((node) => [
      text(node['id']),
      text(node['ssh']),
      text(node['workspace']),
    ])
  );
}

function showComputers(session: Session, data: Record<string, unknown>): void {
  const computers = Array.isArray(data['computers'])
    ? data['computers'].filter(record)
    : [];
  session.display.table(
    ['Computer', 'OS', 'Online'],
    computers.map((peer) => [
      text(peer['dns']),
      text(peer['os']),
      peer['online'] === true ? 'yes' : 'no',
    ])
  );
  session.display.write(
    'Visible Tailscale computers only; mobile devices excluded. Register each remote computer with its existing SSH alias and checkout path before full health checks.'
  );
}

function showAttention(
  session: Session,
  checks: ReturnType<typeof reportChecks>
): void {
  const attention = checks.filter((check) => check.status !== 'pass');
  if (!attention.length) return;
  session.display.table(
    ['Computer', 'Check', 'Status / next step'],
    attention
      .slice(0, 15)
      .map((check) => [
        check.node,
        check.id,
        `${check.status}: ${check.remedy ?? check.summary}`,
      ])
  );
  if (attention.length > 15)
    session.display.write(
      `Showing 15 of ${attention.length} checks needing attention. Explore checks and remedies for the complete report.`
    );
}

function showData(session: Session, outcome: CommandOutcome): void {
  if (!record(outcome.data)) return;
  if (['repair', 'repairs'].includes(String(outcome.data['command'])))
    showRepairs(session, outcome.data);
  if (successful(outcome) && outcome.data['command'] === 'nodes')
    showNodes(session, outcome.data);
  if (outcome.data['command'] === 'discover')
    showComputers(session, outcome.data);
}

function outcomeState(outcome: CommandOutcome, incomplete: number): string {
  if (record(outcome.data) && outcome.data['applied'] === false)
    return 'PREVIEW';
  if (!successful(outcome)) return 'FAILED';
  return incomplete ? 'WARNING' : 'SUCCESS';
}
