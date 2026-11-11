import { AgentConfigurationError } from './errors';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, registry, type Selection } from './registry';
import { render } from './render';
import {
  atomicWrite,
  backup,
  fileState,
  readOwned,
  safeParents,
} from './files';

export type Receipt = {
  version: 1;
  revision: string;
  fingerprint: string;
  files: Record<string, string>;
};
export type Context = { root: string; revision: string; selection: Selection };

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

export async function convergeAgents(context: Context, adopt = false) {
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
    for (const file of result.files) {
      if (file.state === 'unchanged') continue;
      if ((await readOwned(file.path)) !== null)
        await backup(file.path, context.root);
      await atomicWrite(file.path, file.content);
    }
    const receipt: Receipt = {
      version: 1,
      revision: context.revision,
      fingerprint: result.fingerprint,
      files: Object.fromEntries(
        result.files.map((file) => [file.name, digest(file.content)])
      ),
    };
    const encoded = JSON.stringify(receipt, null, 2) + '\n';
    if ((await readOwned(result.receiptPath)) !== encoded)
      await atomicWrite(result.receiptPath, encoded);
    return {
      ...publicPlan(result, context.revision),
      appliedRevision: context.revision,
      receiptMatches: true,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
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
