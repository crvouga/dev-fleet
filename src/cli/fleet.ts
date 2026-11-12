import { selectNodes } from '../config';
import { doctor } from '../manager';
import { FleetUsageError } from '../errors';
import { onboarding } from '../onboard';
import { makeReport, renderReport, reportExitCode } from '../report';
import { runCommand } from '../runner';
import schema from '../../schema/roster.schema.json';
import type { FleetConfig, FleetNode, NodeReport, Runner } from '../types';
import type { CommandOutcome } from './contracts';
import type { Settings } from './settings';
import { capabilities, timeout, validateOptions } from './options';
import type { CliOptions } from './options';
import { addNode, nodeFromOptions, readRoster } from './roster';
import { executeTailnet } from './tailnet';
import { probeSource } from './probe-source';
import { executeRepairCommand } from './repair';
import { scheduleCheck } from '../schedule-check';
import { readHistory } from '../state/history';
import { withUsage } from '../worker-activity';
import { activeNodes, appendUsage } from './worker-usage-report';
import { fleet, secret } from '../fleet-config';
import { appendTailnetLeftovers } from '../tailnet-cleanup';
import { fleetTailnetControl, type TailnetControl } from '../tailnet-control';

export interface FleetServices {
  run: Runner;
  source: () => Promise<string>;
  /** The tailnet control plane fleet.json declares, asked for devices
   * tagged as workers that no declared worker accounts for. Absent, or null,
   * fleet-status says nothing about them.
   */
  tailnet?: () => Promise<TailnetControl | null>;
}

const SERVICES: FleetServices = {
  run: runCommand,
  source: probeSource,
  tailnet: () => fleetTailnetControl(fleet.tailnet, secret),
};

export async function executeFleet(
  command: string,
  options: CliOptions,
  settings: Settings,
  services: FleetServices = SERVICES
): Promise<CommandOutcome> {
  validateOptions(command, options);
  if (['repair', 'repairs'].includes(command))
    return executeRepairCommand(command, options, settings, services);
  if (['discover', 'health'].includes(command))
    return executeTailnet(command, options, settings, services);
  if (command === 'schema') return result(schema);
  if (command === 'add') return register(settings, options);
  const roster = options.local ? null : await readRoster(settings.config);
  const nodes = resolveNodes(command, options, roster);
  if (['nodes', 'onboard'].includes(command))
    return rosterResult(command, nodes, roster !== null);
  return diagnose(
    nodes,
    options,
    { ...settings, missingRoster: !roster },
    services
  );
}

function rosterResult(
  command: string,
  nodes: FleetNode[],
  configured: boolean
): CommandOutcome {
  return result({
    version: 1,
    command,
    ok: true,
    ...(command === 'nodes' ? { configured } : {}),
    nodes:
      command === 'onboard'
        ? nodes.map((node) => onboarding(node, 'devfleet'))
        : nodes,
  });
}

function resolveNodes(
  command: string,
  options: CliOptions,
  roster: FleetConfig | null
): FleetNode[] {
  if (!roster && !options.local && !['doctor', 'nodes'].includes(command))
    throw new FleetUsageError(
      'No fleet roster. Use fleet-node-add or the interactive Register action; use fleet-status --local for this machine.'
    );
  if (options.node?.length && !roster)
    throw new FleetUsageError(
      'Cannot select nodes without a roster. Use fleet-node-add first.'
    );
  return roster ? selectNodes(roster, options.node ?? []) : [];
}

function result(data: unknown, text?: string): CommandOutcome {
  return { exitCode: 0, data, ...(text ? { text } : {}) };
}

async function register(
  settings: Settings,
  options: CliOptions
): Promise<CommandOutcome> {
  const node = nodeFromOptions(options);
  const added = await addNode(settings.config, node, options.apply === true);
  return result({
    version: 1,
    command: 'add',
    ok: true,
    applied: options.apply === true,
    path: settings.config,
    // How the fleet state stands with the bucket after this change.
    ...(added.standing ? { state: added.standing } : {}),
    node,
    nodes: added.roster.nodes,
    next: options.apply
      ? 'Run fleet-nodes --onboard, then fleet-status --json.'
      : 'Review this preview, then repeat with --apply --yes.',
  });
}

async function diagnose(
  nodes: FleetNode[],
  options: CliOptions,
  settings: Settings & { missingRoster: boolean },
  services: FleetServices
): Promise<CommandOutcome> {
  // A parked worker is not contacted; it is listed as parked.
  const active = activeNodes(nodes);
  const source = active.length ? await services.source() : undefined;
  const reports = await doctor(
    active,
    {
      root: settings.workspace,
      local: options.local === true,
      required: capabilities(options.require),
      timeoutMs: timeout(options),
      ...(source ? { source } : {}),
    },
    services.run
  );
  if (!options.local && settings.missingRoster) reports.push(missingRoster());
  const schedule = scheduleCheck(readHistory(), new Date());
  if (schedule) reports[0]?.checks.push(schedule);
  // What each worker is doing, unless only this manager is checked.
  const usage = await usageOf(
    reports,
    active,
    services.run,
    skipsFleet(options, settings)
  );
  // Devices tagged as workers that are no declared worker (#123).
  if (!skipsFleet(options, settings))
    await appendTailnetLeftovers(reports, fleet, services.tailnet, nodes);
  const report = {
    ...makeReport('doctor', reports),
    ...(usage ?? {}),
    coverage: {
      scope: options.local
        ? 'local'
        : options.node?.length
          ? 'selected'
          : 'all-configured',
      manager: true,
      configuredNodesTested: nodes.map((node) => node.id),
      rosterAvailable: !settings.missingRoster,
      note: 'Directed SSH checks from this manager only. T3 relay/peer and VS Code forwarding require operator tests.',
    },
  };
  return {
    exitCode: reportExitCode(report, options.strict === true),
    data: report,
    text: withUsage(renderReport(report), usage),
  };
}

/** Only this manager is checked: what is said of the fleet is skipped. */
function skipsFleet(
  options: CliOptions,
  settings: { missingRoster: boolean }
): boolean {
  return Boolean(options.local || settings.missingRoster);
}

function usageOf(
  reports: NodeReport[],
  nodes: FleetNode[],
  run: Runner,
  skip: boolean
) {
  return skip ? Promise.resolve(null) : appendUsage(reports, nodes, { run });
}

function missingRoster(): NodeReport {
  return {
    node: 'fleet',
    checks: [
      {
        id: 'fleet:roster',
        status: 'fail',
        summary:
          'No developer fleet roster is configured. Only this manager could be checked; fleet-wide health is unknown.',
        remedy: {
          action:
            'Open personal --interactive and choose Register a developer computer, or run devfleet fleet-node-add --help. Then run fleet-status --json.',
        },
      },
    ],
  };
}
