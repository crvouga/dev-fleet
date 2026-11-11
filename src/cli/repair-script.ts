import { automaticRepairs } from '../repair-plan';
import { recipe } from '../repair-catalog';
import { shellQuote, sshArgs } from '../ssh';
import type { RepairTarget, RepairStep } from '../repair-plan';

export function targetCommand(
  target: RepairTarget,
  commands: string[][]
): string {
  const command = `cd -- ${shellQuote(target.root)} && ${commands.map((args) => args.map(shellQuote).join(' ')).join(' && ')}`;
  if (!target.node) return command;
  return [
    ...sshArgs(target.node)
      .map((arg) => (arg === '-T' ? '-t' : arg))
      .map(shellQuote),
    shellQuote(command),
  ].join(' ');
}

/** Generates a reviewable operator script. It is never written or executed by this command. */
export function repairScript(
  steps: RepairStep[],
  targets: RepairTarget[]
): string {
  const lines = [
    '#!/bin/sh',
    'set -eu',
    '# Generated repair plan. Review before running in your own terminal.',
    '# Automated steps use existing owners. Native login commands below are commented and require operator approval.',
    '# POSIX shell required; Windows operators can use the personal commands directly.',
  ];
  for (const target of targets) {
    const actions = automaticRepairs(steps, target.name);
    if (!actions.length) continue;
    const commands = actions.flatMap((step) =>
      step.id === 'workspace'
        ? [
            [
              'bun',
              'src/cli/cli.ts',
              'fleet-repair',
              '--local',
              '--repair',
              'workspace',
              '--apply',
              '--yes',
              '--json',
            ],
          ]
        : recipe(step.id).commands
    );
    lines.push('', targetCommand(target, commands));
  }

  for (const step of steps.filter(
    (entry) => !entry.automatic || !entry.eligible
  )) {
    lines.push(
      '',
      `# ${comment(step.node)} / ${comment(step.title)}`,
      `# ${comment(step.action)}`
    );
    const target = targets.find((entry) => entry.name === step.node);
    if (target && step.eligible && step.commands.length)
      lines.push(`# ${targetCommand(target, step.commands)}`);
    else for (const next of step.next) lines.push(`# ${comment(next)}`);
  }
  lines.push(
    '',
    '# Re-run devfleet fleet-status --tailnet --json for fresh whole-tailnet coverage.'
  );
  return `${lines.join('\n')}\n`;
}
function comment(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
}
