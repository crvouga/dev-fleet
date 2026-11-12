import { AgentConfigurationError } from './errors';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, registry, type Selection } from './registry';
import { render } from './render';
import { readOwned, fileState, safeParents } from './files';
import { runAnsible } from '../platform/ansible';
import { PACKAGE_ROOT } from '../package-info';
import { runCommand } from '../runner';
import type { CommandResult, Runner } from '../types';

export type Receipt = {
  version: 1;
  revision: string;
  fingerprint: string;
  files: Record<string, string>;
};
export type Context = { root: string; revision: string; selection: Selection };

/** What `ansible/agents/agents.yml` is given to write one profile. TypeScript
 * decides here, beforehand, what is backed up and what each file must hash
 * to; the play renders the files from its templates and asserts them.
 */
export interface ProfileVariables {
  agent_root: string;
  agent_node: string;
  agent_tool: string;
  agent_profile: string;
  agent_model: string;
  /** Empty for a direct profile: it never names the proxy. */
  agent_proxy_endpoint: string;
  /** The model of every proxy route, in the registry's order. */
  agent_proxy_models: string[];
  /** The SHA-256 of each file as src/agents/render.ts specifies it. */
  agent_files: Record<string, string>;
  /** What the receipt records beside those digests. */
  agent_revision: string;
  agent_fingerprint: string;
  /** Files to copy into ROOT/backups before they are replaced. */
  agent_backups: { source: string; dest: string }[];
}

/** Runs the agents play with these variables. */
export type ProfilePlay = (
  variables: ProfileVariables
) => Promise<CommandResult>;

/** The package's agents play, with the Ansible this machine runs. `scratch`
 * is where its variables file is kept while it runs (the fleet's private
 * run directory by default).
 */
export function agentsPlay(
  run: Runner = runCommand,
  options: { check?: boolean; scratch?: string } = {}
): ProfilePlay {
  const directory = join(PACKAGE_ROOT, 'ansible', 'agents');
  return (variables) =>
    runAnsible(
      run,
      join(directory, 'agents.yml'),
      {
        cwd: directory,
        input: JSON.stringify(variables),
        // Inside the two minutes the sync gives `agents apply`.
        timeoutMs: 90_000,
        ...(options.check ? { check: true } : {}),
      },
      options.scratch
    );
}

export async function plan(context: Context) {
  const { root, selection } = context;
  const directory = join(
    root,
    selection.node,
    selection.tool,
    selection.profile
  );
  const receiptPath = join(directory, 'receipt.json');
  const raw = await readOwned(receiptPath);
  const previous = raw ? parseReceipt(raw) : null;
  const outputs = render(selection);
  const files = [];
  for (const [name, content] of Object.entries(outputs)) {
    const path = join(directory, name);
    const current = await readOwned(path);
    files.push({
      name,
      path,
      content,
      state: fileState(current, content, previous?.files[name]),
    });
  }
  const fingerprint = digest(JSON.stringify({ registry, selection, outputs }));
  return { directory, receiptPath, previous, files, fingerprint };
}

/** Applies one profile. A file someone edited is refused unless `adopt`;
 * then the agents play writes the profile, and what it wrote is measured
 * against the specification before this reports success. With nothing to
 * change, the play is not run.
 */
export async function convergeAgents(
  context: Context,
  adopt = false,
  play: ProfilePlay = agentsPlay()
) {
  await safeParents(context.root);
  await mkdir(context.root, { recursive: true, mode: 0o700 });
  const lock = join(context.root, '.apply-lock');
  try {
    await mkdir(lock);
  } catch {
    throw new AgentConfigurationError(
      'Another apply is active; inspect .apply-lock before retrying.'
    );
  }
  try {
    const result = await plan(context);
    if (!adopt && result.files.some((file) => file.state === 'conflict'))
      throw new AgentConfigurationError(
        'Unmanaged or modified configuration. Review locally, then use --adopt to back up and replace only this profile.'
      );
    const { receipt, encoded } = receiptFor(result, context.revision);
    const changing = result.files.filter((file) => file.state !== 'unchanged');
    if (changing.length || (await readOwned(result.receiptPath)) !== encoded) {
      const applied = await play(
        profileVariables(context, receipt, {
          backups: changing
            .filter((file) => file.state !== 'create')
            .map((file) => ({
              source: file.path,
              dest: join(context.root, 'backups', randomUUID()),
            })),
        })
      );
      if (!applied.ok)
        throw new AgentConfigurationError(
          'The agents play (ansible/agents/agents.yml) failed for this profile; no receipt was advanced and its output is not reported. Inspect the profile with agents preview, then apply again.'
        );
      await measure(context, encoded);
    }
    return {
      ...publicPlan(result, context.revision),
      appliedRevision: context.revision,
      receiptMatches: true,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** The receipt an apply of this plan records, and its exact text. */
export function receiptFor(
  result: Awaited<ReturnType<typeof plan>>,
  revision: string
): { receipt: Receipt; encoded: string } {
  const receipt: Receipt = {
    version: 1,
    revision,
    fingerprint: result.fingerprint,
    files: Object.fromEntries(
      result.files.map((file) => [file.name, digest(file.content)])
    ),
  };
  return { receipt, encoded: JSON.stringify(receipt, null, 2) + '\n' };
}

export function profileVariables(
  context: Context,
  receipt: Receipt,
  options: { backups: { source: string; dest: string }[] } = { backups: [] }
): ProfileVariables {
  const { selection } = context;
  return {
    agent_root: context.root,
    agent_node: selection.node,
    agent_tool: selection.tool,
    agent_profile: selection.profile,
    agent_model: selection.model,
    agent_proxy_endpoint:
      selection.profile === 'proxy' ? registry.proxy.endpoint : '',
    agent_proxy_models: Object.values(registry.proxy.routes).map(
      (route) => route.model
    ),
    agent_files: receipt.files,
    agent_revision: receipt.revision,
    agent_fingerprint: receipt.fingerprint,
    agent_backups: options.backups,
  };
}

/** After the play: every file is what was specified, byte for byte, and the
 * receipt is the one this apply decided on.
 */
async function measure(context: Context, encoded: string): Promise<void> {
  const after = await plan(context);
  if (
    after.files.some((file) => file.state !== 'unchanged') ||
    (await readOwned(after.receiptPath)) !== encoded
  )
    throw new AgentConfigurationError(
      'After the agents play, the profile on disk is not what dev-fleet specifies. Inspect it with agents preview before applying again.'
    );
}

export function publicPlan(
  result: Awaited<ReturnType<typeof plan>>,
  revision: string
) {
  return {
    revision,
    appliedRevision: result.previous?.revision ?? null,
    fingerprint: result.fingerprint,
    receiptMatches: result.previous?.fingerprint === result.fingerprint,
    files: result.files.map(({ name, state }) => ({ name, state })),
    t3EndToEnd: 'unverified',
    authenticatedInference: 'unverified',
  };
}

function parseReceipt(raw: string): Receipt {
  const value = JSON.parse(raw) as Receipt;
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !value.files ||
    !Object.values(value.files).every(
      (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
    )
  )
    throw new AgentConfigurationError(
      'Invalid configuration receipt. Inspect it locally and restore a known receipt before applying.'
    );
  return value;
}
