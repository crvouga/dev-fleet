import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { runAnsible } from './ansible';
import type { CommandOptions, CommandResult, Runner } from '../types';

/** Full re-apply at least this often, so drift a cheap check misses still heals. */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Receipt {
  /** Stable receipt name, e.g. `ubuntu-baseline`. */
  name: string;
  /** Files or directories whose content the playbook result depends on. */
  sources: string[];
  /** Cheap postcondition probe; a skip happens only while it passes. */
  verify: () => Promise<boolean>;
  /** Ignore any receipt and apply in full. */
  force?: boolean;
  /** Receipt directory; defaults to the user's fleet state. */
  directory?: string;
  /** Run the playbook in check mode first, and apply only when that passes. */
  checkFirst?: boolean;
  /** Where the playbook's variables are written while it runs. */
  scratch?: string;
  now?: number;
}

export interface ReceiptResult extends CommandResult {
  /** True when the playbook was skipped on an unchanged, verified receipt. */
  cached: boolean;
  /** Which run the result is of: the check-mode run when it failed. */
  stage?: 'check' | 'apply';
}

export function receiptDirectory(home = homedir()): string {
  return join(home, '.local/state/personal/fleet/receipts');
}

/** Ansible is idempotent but slow (fact gathering, package and service
 * inspection). A successful apply records a digest of its exact inputs
 * (playbook sources and variables, never the variables themselves). A later
 * run with the same digest skips the playbook while the cheap postcondition
 * still holds; any input change, failed probe, failed apply or a receipt
 * older than a day applies in full again.
 */
export async function runAnsibleWithReceipt(
  run: Runner,
  playbook: string,
  options: CommandOptions & { input: string },
  receipt: Receipt
): Promise<ReceiptResult> {
  const directory = receipt.directory ?? receiptDirectory();
  const path = join(directory, `${receipt.name}.json`);
  const now = receipt.now ?? Date.now();
  const key = await inputKey(playbook, options.input, receipt.sources);
  if (
    !receipt.force &&
    key !== null &&
    (await fresh(path, key, now)) &&
    (await receipt.verify().catch(() => false))
  )
    return { ok: true, reason: 'exit', stdout: '', stderr: '', cached: true };
  await rm(path, { force: true }).catch(() => undefined);
  if (receipt.checkFirst) {
    const checked = await runAnsible(
      run,
      playbook,
      { ...options, check: true },
      receipt.scratch
    );
    if (!checked.ok) return { ...checked, cached: false, stage: 'check' };
  }
  const result = await runAnsible(run, playbook, options, receipt.scratch);
  if (result.ok && key !== null)
    await record(directory, path, { version: 1, key, appliedAt: now });
  return { ...result, cached: false, stage: 'apply' };
}

/** Best effort: a missing receipt only means the next run applies in full. */
async function record(directory: string, path: string, value: object) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  } catch {
    /* Never fail a successful apply over its receipt. */
  }
}

async function fresh(path: string, key: string, now: number) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      version?: unknown;
      key?: unknown;
      appliedAt?: unknown;
    };
    return (
      value.version === 1 &&
      value.key === key &&
      typeof value.appliedAt === 'number' &&
      now - value.appliedAt >= 0 &&
      now - value.appliedAt < RECEIPT_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

/** Null when any source is unreadable: then the playbook always runs. */
export async function inputKey(
  playbook: string,
  input: string,
  sources: string[]
): Promise<string | null> {
  const hash = createHash('sha256');
  hash.update(`playbook\0${playbook}\0input\0${input}\0`);
  try {
    for (const source of [...sources].sort())
      for (const file of await files(source)) {
        hash.update(`${relative(source, file)}\0`);
        hash.update(await readFile(file));
        hash.update('\0');
      }
  } catch {
    return null;
  }
  return hash.digest('hex');
}

async function files(source: string): Promise<string[]> {
  const entries = await readdir(source, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  });
  if (entries === null) return [source];
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}
