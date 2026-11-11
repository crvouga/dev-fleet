import type { CommandOutcome, CommandSpec } from './contracts';
import { execute, showOutcome, successful } from './ui-execute';
import { clean, reportChecks, reproduction, record } from './ui-data';
import { inspectChecks, inspectDetails } from './ui-reports';
import { chooseTargets } from './ui-targets';
import type { Choice, Session } from './ui-types';

export async function runCommand(
  session: Session,
  command: CommandSpec
): Promise<void> {
  session.display.panel(clean(command.title), clean(command.description));
  const args = await actionArgs(session, command);
  if (!args) return;
  const preview = isRepair(args);
  const mutation = !preview && (command.mutation || args.includes('--apply'));
  if (mutation && !(await confirmMutation(session, args))) return;
  await runWithResults(session, args, command.title, { preview, mutation });
}

function isRepair(args: string[]): boolean {
  return args[0] === 'fleet-repair' && !args.includes('--list');
}

/** Palette entries with flags are fixed scopes; bare roster commands ask for targets. */
function targetAction(args: string[]): string | undefined {
  if (isRepair(args)) return 'repair';
  if (args[0] === 'fleet-status' && args.length === 1) return 'doctor';
  if (args[0] === 'fleet-nodes' && args.includes('--onboard')) return 'onboard';
  return undefined;
}

async function actionArgs(
  session: Session,
  command: CommandSpec
): Promise<string[] | undefined> {
  const args = [...command.args];
  const action = targetAction(args);
  if (!action) return args;
  const targets = await chooseTargets(session, action);
  return targets ? [...args, ...targets] : undefined;
}

export async function runWithResults(
  session: Session,
  initialArgs: string[],
  title: string,
  settings: { preview?: boolean; mutation?: boolean } = {}
): Promise<void> {
  let args = initialArgs;
  let outcome = await execute(session, args, title);
  let preview = settings.preview === true;
  let mutation = settings.mutation === true;
  while (true) {
    showOutcome(session, outcome);
    const selection = await session.prompts.select(
      'Next step',
      resultChoices(outcome, preview)
    );
    if (selection === 'back') return;
    await inspectSelection(session, outcome, selection);
    if (selection === 'apply') {
      const appliedArgs = applyArgs(args, outcome);
      if (!(await confirmMutation(session, appliedArgs))) continue;
      args = appliedArgs;
      preview = false;
      mutation = true;
      outcome = await execute(session, args, title);
    }
    if (selection === 'retry') {
      if (mutation && !(await confirmMutation(session, args))) continue;
      outcome = await execute(session, args, title);
    }
  }
}

async function inspectSelection(
  session: Session,
  outcome: CommandOutcome,
  selection: string
): Promise<void> {
  if (selection === 'checks') await inspectChecks(session, outcome.data);
  if (selection === 'details') await inspectDetails(session, outcome.data);
}

function resultChoices(outcome: CommandOutcome, preview: boolean): Choice[] {
  return [
    { name: 'Back to commands', value: 'back' },
    ...(reportChecks(outcome.data).length
      ? [{ name: 'Explore checks and remedies…', value: 'checks' }]
      : []),
    { name: 'Inspect structured details / plan…', value: 'details' },
    ...(preview && successful(outcome)
      ? [{ name: 'Review and explicitly apply…', value: 'apply' }]
      : []),
    ...(!successful(outcome)
      ? [{ name: 'Retry command…', value: 'retry' }]
      : []),
  ];
}

export async function confirmMutation(
  session: Session,
  args: string[]
): Promise<boolean> {
  const action = args[0];
  const warning =
    action === 'fleet-repair'
      ? 'Repair runs the eligible owner actions in the displayed plan, including trusted setup/install scripts. Workstation actions may read this machine’s Vault session and write managed 0600 provider configuration. No login session is transferred between computers. Failures can leave partial changes; fresh diagnostics follow.'
      : action === 'fleet-node-add'
        ? 'This writes the local roster only. No cloud resources, SSH configuration, credentials or host keys are changed.'
        : 'This command applies changes on invocation as documented in its --help. Failure can leave partial changes; inspect before retrying. No credentials are copied between computers.';
  session.display.panel(
    'Explicit approval required',
    [
      warning,
      `Workspace: ${clean(session.workspace ?? session.options.workspace)}`,
      `Config: ${clean(session.config ?? session.options.config)}`,
      `$ ${reproduction(session, args)}`,
    ].join('\n')
  );
  return session.prompts.confirm('Apply this exact command? (default: no)');
}

function applyArgs(args: string[], outcome: CommandOutcome): string[] {
  const guard =
    isRepair(args) &&
    record(outcome.data) &&
    typeof outcome.data['planHash'] === 'string'
      ? ['--plan-hash', outcome.data['planHash']]
      : [];
  return [...args, ...guard, '--apply', '--yes'];
}
