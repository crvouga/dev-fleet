import { confirmMutation, runWithResults } from './ui-actions';
import { absolutePath, clean, reproduction } from './ui-data';
import type { Session } from './ui-types';

const CAPABILITIES = ['github', 'vault', 't3', 'vscode', 'toolchain'];

export async function addNode(session: Session): Promise<void> {
  showIntro(session);
  await registerNode(session);
}

function showIntro(session: Session): void {
  session.display.panel(
    'fleet-node-add',
    [
      'Register an EXISTING computer in your local secret-free roster.',
      'Use a previously verified SSH alias. This wizard never connects, provisions, logs in or changes host keys.',
      'Cancel with Ctrl+C. No write occurs until you approve the preview.',
    ].join('\n')
  );
}

async function registerNode(session: Session): Promise<void> {
  const id = await session.prompts.input(
    'Node ID (lowercase, e.g. dev-linux)',
    '',
    validId
  );
  const alias = await session.prompts.input(
    'Existing SSH alias / hostname',
    id,
    validAlias
  );
  const workspace = await session.prompts.input(
    'Absolute POSIX workspace on the node',
    '',
    absolutePath
  );
  const runtime = await session.prompts.input(
    'Optional absolute Node/Bun executable (blank = node on SSH PATH)',
    '',
    (value) => value === '' || absolutePath(value)
  );
  const capabilities = await session.prompts.checkbox(
    'Required capabilities · space to toggle',
    CAPABILITIES.map((capability) => ({
      name: capability,
      value: capability,
      checked: capability !== 'vscode',
    }))
  );
  const args = [
    'fleet-node-add',
    '--id',
    id,
    '--ssh',
    alias,
    '--path',
    workspace,
    ...(runtime ? ['--runtime', runtime] : []),
    '--require',
    capabilities.join(',') || 'none',
    '--apply',
    '--yes',
  ];
  session.display.table(
    ['Field', 'Preview'],
    [
      ['ID', clean(id)],
      ['SSH', clean(alias)],
      ['Workspace', clean(workspace)],
      ['Runtime', clean(runtime) || 'node (remote non-login PATH)'],
      ['Required', capabilities.join(', ') || 'none'],
    ]
  );
  session.display.write(`$ ${reproduction(session, args)}`);
  if (!(await confirmMutation(session, args))) {
    session.display.write('Cancelled — no roster was written.');
    return;
  }
  await runWithResults(session, args, 'Saving roster node (no SSH)', {
    mutation: true,
  });
  session.display.write(
    'Next: fleet-nodes --onboard --node ID for operator-owned SSH / authentication guidance, then fleet-status.'
  );
}

function validId(value: string): boolean | string {
  return (
    /^[a-z][a-z0-9-]{0,62}$/.test(value) ||
    'Use 1–63 lowercase letters, digits or hyphens; start with a letter.'
  );
}

function validAlias(value: string): boolean | string {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value) ||
    'Use an existing plain SSH alias/hostname; no user@host, options or ports.'
  );
}
