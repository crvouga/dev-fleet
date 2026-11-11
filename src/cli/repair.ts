import { AUTOMATED_REPAIRS, REPAIR_RECIPES, recipe } from '../repair-catalog';
import { repairPlan } from '../repair-plan';
import { makeReport, reportExitCode } from '../report';
import { FleetUsageError } from '../errors';
import { inspectRepair } from './repair-inspect';
import { applyRepairs } from './repair-apply';
import { repairScript } from './repair-script';
import { repairPlanHash } from './repair-guard';
import type { AutomatedRepair } from '../repair-catalog';
import type { RepairStep } from '../repair-plan';
import type { FleetServices } from './fleet';
import type { CliOptions } from './options';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';

export function requestedRepairs(
  value?: string
): AutomatedRepair[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(',');
  if (
    !ids.length ||
    ids.some((id) => !AUTOMATED_REPAIRS.includes(id as AutomatedRepair))
  )
    throw new FleetUsageError(
      '--repair expects workspace,workstation,providers. Native logins require operator approval; inspect fleet-repair --list.'
    );
  return [...new Set(ids)] as AutomatedRepair[];
}
export function repairCatalog(): CommandOutcome {
  return {
    exitCode: 0,
    data: {
      version: 1,
      command: 'repairs',
      ok: true,
      recipes: REPAIR_RECIPES,
      credentials: [
        'Authenticate each computer independently with the intended identity. Never clone OAuth caches, browser cookies, keychains, SSH private keys or Vault sessions.',
        "Shared secrets come from the fleet's secrets provider with this machine's own access (see `secrets` in the fleet configuration).",
        'A login does not grant every account, team or resource permission.',
      ],
    },
  };
}

export async function executeRepairCommand(
  command: string,
  options: CliOptions,
  settings: Settings,
  services: FleetServices
): Promise<CommandOutcome> {
  return command === 'repairs'
    ? repairCatalog()
    : executeRepair(options, settings, services);
}

export async function executeRepair(
  options: CliOptions,
  settings: Settings,
  services: FleetServices
): Promise<CommandOutcome> {
  const selected = requestedRepairs(options.repair);
  const before = await inspectRepair(options, settings, services);
  const steps = selectRepairs(
    repairPlan(before.reports, before.targets),
    before,
    selected
  );
  const planHash = repairPlanHash(steps, before.targets);
  if (options.planHash && options.planHash !== planHash)
    throw new FleetUsageError(
      'Repair plan changed since review. Generate and review a fresh preview; nothing was applied.'
    );
  const initial = makeReport('repair', before.reports);
  const healthOk = reportExitCode(initial, true) === 0;
  const script = options.script
    ? repairScript(steps, before.targets)
    : undefined;
  if (!options.apply)
    return {
      exitCode: 0,
      data: {
        ...initial,
        ok: true,
        applied: false,
        planHash,
        healthOk,
        coverage: before.coverage,
        steps,
        ...(script ? { script } : {}),
        authorize:
          'Preview only. Review effects, then repeat with --apply --yes. Only eligible automatic steps execute. Native logins and manual steps remain operator work.',
      },
      text: script ?? renderSteps(steps),
    };
  return appliedOutcome(steps, before, { options, settings, services });
}

async function appliedOutcome(
  steps: RepairStep[],
  before: Awaited<ReturnType<typeof inspectRepair>>,
  context: {
    options: CliOptions;
    settings: Settings;
    services: FleetServices;
  }
): Promise<CommandOutcome> {
  const { options, settings, services } = context;
  const executions = await applyRepairs(
    before.targets,
    steps,
    options,
    services
  );
  const after = await recheckRepair(before, options, settings, services);
  const checked = makeReport('repair', after.reports);
  const executionOk = executions.every((node) =>
    node.checks.every((check) => check.status === 'pass')
  );
  const verified = reportExitCode(checked, true) === 0;
  const ok = executionOk && verified;
  return {
    exitCode: ok ? 0 : 1,
    data: {
      ...checked,
      ok,
      applied: true,
      executionOk,
      healthOk: verified,
      coverage: after.coverage,
      steps,
      executions,
      remaining: repairPlan(after.reports, after.targets),
      completed: executions
        .flatMap((node) => node.checks)
        .filter((check) => check.status === 'pass').length,
    },
    text: `Repair commands ${executionOk ? 'completed' : 'need attention'}; fresh health ${verified ? 'verified' : 'still has failing or unverified checks'}.\n${renderSteps(repairPlan(after.reports, after.targets))}`,
  };
}

function selectRepairs(
  steps: RepairStep[],
  inspection: Awaited<ReturnType<typeof inspectRepair>>,
  selected?: AutomatedRepair[]
): RepairStep[] {
  if (!selected) return steps;
  const filtered = steps.filter(
    (step) => !step.automatic || selected.includes(step.id as AutomatedRepair)
  );
  for (const target of inspection.targets) {
    const report = inspection.reports.find(
      (entry) => entry.node === target.name
    );
    if (!report?.snapshot) continue;
    for (const id of selected)
      if (!filtered.some((step) => step.node === target.name && step.id === id))
        filtered.push({
          ...recipe(id),
          node: target.name,
          eligible: true,
          checks: ['explicit:request'],
          next: [
            'Explicitly requested owner action; fresh diagnostics still follow.',
          ],
        });
  }
  return filtered;
}
function renderSteps(steps: RepairStep[]): string {
  return steps
    .map(
      (step) =>
        `${step.node} / ${step.id}: ${step.automatic && step.eligible ? 'automatic after --apply --yes' : 'operator action'}\n  ${step.action}`
    )
    .join('\n');
}

async function recheckRepair(
  before: Awaited<ReturnType<typeof inspectRepair>>,
  options: CliOptions,
  settings: Settings,
  services: FleetServices
): Promise<Awaited<ReturnType<typeof inspectRepair>>> {
  try {
    return await inspectRepair(options, settings, services);
  } catch {
    return {
      reports: before.reports.map((report) => ({
        node: report.node,
        checks: [
          {
            id: 'repair:recheck',
            status: 'fail',
            summary:
              'Fresh diagnostics could not complete after repair. Earlier diagnostics are not being treated as fresh; inspect this computer and rerun health.',
          },
        ],
      })),
      targets: [],
      coverage: {
        ...before.coverage,
        limitation:
          'Post-repair diagnostics failed. Execution results are retained; machine health remains unverified.',
      },
    };
  }
}
