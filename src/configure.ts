import { join } from 'node:path';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { record } from './config';
import type { Check, Runner } from './types';

export type ConfigurationRequest = {
  revision: string;
  tool: string;
  profile: string;
  node: string;
};

export function validConfiguration(
  value: unknown
): value is ConfigurationRequest {
  return (
    record(value) &&
    typeof value['revision'] === 'string' &&
    /^[a-f0-9]{40}$/.test(value['revision']) &&
    ['codex', 'claude', 'opencode', 'gemini', 'grok', 'antigravity'].includes(
      String(value['tool'])
    ) &&
    ['direct', 'proxy'].includes(String(value['profile'])) &&
    typeof value['node'] === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(value['node'])
  );
}

/** A pinned deployment worktree leaves the developer's branch and dirty files intact. */
export async function configureWorkspace(
  root: string,
  request: ConfigurationRequest,
  run: Runner,
  options: { additionalTools: string[]; bootstrappedDeployment: boolean } = {
    additionalTools: [],
    bootstrappedDeployment: false,
  }
): Promise<Check[]> {
  if (
    options.additionalTools.some(
      (tool) => !validConfiguration({ ...request, tool })
    )
  )
    return failure('Invalid additional profile.');
  if (!validConfiguration(request))
    return failure('Invalid reviewed revision or configuration selection.');
  const directory = deploymentDirectory(
    root,
    request.revision,
    options.bootstrappedDeployment
  );
  const head = await run(
    ['git', 'rev-parse', '--verify', `${request.revision}^{commit}`],
    { cwd: root }
  );
  if (!head.ok || head.stdout.trim() !== request.revision)
    return failure(
      'Reviewed commit is unavailable locally. Fetch it explicitly and retry.'
    );
  const prepared = await prepareRevision(
    root,
    directory,
    request.revision,
    run
  );
  if (prepared.length) return prepared;
  if (!options.bootstrappedDeployment) {
    const setup = await setupRevision(directory, run);
    if (setup.length) return setup;
  }
  const checks: Check[] = [];
  for (const tool of [request.tool, ...options.additionalTools]) {
    checks.push(
      ...(await applyProfile(root, directory, { ...request, tool }, run))
    );
  }
  return checks;
}
async function setupRevision(directory: string, run: Runner): Promise<Check[]> {
  const setup = await run(
    [
      'mise',
      'exec',
      '--locked',
      'bun',
      '--',
      'bun',
      'bootstrap/setup.ts',
      '--non-interactive',
    ],
    { cwd: directory, timeoutMs: 1_200_000 }
  );
  if (!setup.ok)
    return failure(
      'Existing setup owner failed. Partial tool/dependency installation is possible; no configuration receipt was advanced.'
    );
  return [];
}

async function applyProfile(
  root: string,
  directory: string,
  request: ConfigurationRequest,
  run: Runner
): Promise<Check[]> {
  const applied = await applyOwner(directory, request, run);
  if (!applied.ok)
    return failure(
      'Agent profile configuration failed. Inspect preview on this node; no rollout receipt was advanced.'
    );
  const receipt = decodeReceipt(applied.stdout, request.revision);
  if (!receipt)
    return failure(
      'The agent profile owner returned an invalid receipt; rollout remains unverified.'
    );
  await recordConfiguration(root, request, receipt);
  return [
    {
      id: 'configuration:apply',
      status: 'pass',
      summary: `agent profile applied at revision ${request.revision}; configuration fingerprint ${receipt}. Authentication and T3 end-to-end remain separate gates.`,
    },
  ];
}

export function decodeReceipt(output: string, revision: string): string | null {
  try {
    const data: unknown = JSON.parse(output);
    return record(data) &&
      data['ok'] === true &&
      data['revision'] === revision &&
      typeof data['fingerprint'] === 'string' &&
      /^[a-f0-9]{64}$/.test(data['fingerprint'])
      ? data['fingerprint']
      : null;
  } catch {
    return null;
  }
}

function failure(summary: string): Check[] {
  return [{ id: 'configuration:apply', status: 'fail', summary }];
}

async function prepareRevision(
  root: string,
  directory: string,
  revision: string,
  run: Runner
): Promise<Check[]> {
  if (root === directory) return verifyRevision(directory, revision, run);
  await mkdir(join(root, 'node_modules', '.fleet-revisions'), {
    recursive: true,
  });
  let deployed = await run(['git', 'rev-parse', 'HEAD'], { cwd: directory });
  if (!deployed.ok) {
    const created = await run(
      ['git', 'worktree', 'add', '--detach', directory, revision],
      { cwd: root, timeoutMs: 30_000 }
    );
    if (!created.ok)
      return failure(
        'Cannot create pinned deployment worktree. Existing data was preserved.'
      );
    deployed = await run(['git', 'rev-parse', 'HEAD'], { cwd: directory });
  }
  return verifyRevision(directory, revision, run);
}
async function verifyRevision(
  directory: string,
  revision: string,
  run: Runner
): Promise<Check[]> {
  const deployed = await run(['git', 'rev-parse', 'HEAD'], { cwd: directory });
  const clean = await run(['git', 'status', '--porcelain'], { cwd: directory });
  if (
    !deployed.ok ||
    deployed.stdout.trim() !== revision ||
    !clean.ok ||
    clean.stdout.trim()
  )
    return failure(
      'Pinned deployment checkout differs or is dirty. Inspect it; fleet never resets it.'
    );
  const top = await run(['git', 'rev-parse', '--show-toplevel'], {
    cwd: directory,
  });
  if (!top.ok || top.stdout.trim() !== directory)
    return failure('Deployment path is not its own Git worktree.');
  return [];
}

async function recordConfiguration(
  root: string,
  request: ConfigurationRequest,
  receipt: string
): Promise<void> {
  const receipts = join(root, 'node_modules', '.fleet-configuration');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const path = join(
    receipts,
    `${request.node}-${request.tool}-${request.profile}.json`
  );
  const contents =
    JSON.stringify({ version: 1, ...request, fingerprint: receipt }) + '\n';
  try {
    if ((await readFile(path, 'utf8')) === contents) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

async function applyOwner(
  directory: string,
  request: ConfigurationRequest,
  run: Runner
) {
  return run(
    [
      'mise',
      'exec',
      '--locked',
      'bun',
      '--',
      'bun',
      'src/agents/cli.ts',
      '--json',
      '--yes',
      '--non-interactive',
      'agents',
      'apply',
      '--node',
      request.node,
      '--tool',
      request.tool,
      '--profile',
      request.profile,
    ],
    { cwd: directory, timeoutMs: 120_000 }
  );
}

function deploymentDirectory(
  root: string,
  revision: string,
  bootstrapped: boolean
): string {
  return bootstrapped
    ? root
    : join(root, 'node_modules', '.fleet-revisions', revision);
}
