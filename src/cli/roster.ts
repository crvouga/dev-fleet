import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfig, record } from '../config';
import { FleetUsageError } from '../errors';
import type { FleetConfig, FleetNode } from '../types';
import { capabilities } from './options';
import type { CliOptions } from './options';

export async function readRoster(path: string): Promise<FleetConfig | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new FleetUsageError(
        'Roster must be a regular file smaller than 1 MiB; symlinks are not supported.'
      );
    return parseConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if (record(error) && error['code'] === 'ENOENT') return null;
    if (error instanceof FleetUsageError) throw error;
    throw new FleetUsageError(
      'Cannot read a valid roster. Use fleet-nodes --schema or choose --config PATH.'
    );
  }
}

export function nodeFromOptions(options: CliOptions): FleetNode {
  if (!options.id || !options.ssh || !options.path)
    throw new FleetUsageError(
      'fleet-node-add requires --id NAME --ssh ALIAS --path /absolute/checkout.'
    );
  const node = {
    id: options.id,
    ssh: options.ssh,
    workspace: options.path,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    required: capabilities(options.require ?? 'github,vault,t3,toolchain'),
  };
  return parseConfig({ version: 1, nodes: [node] }).nodes[0]!;
}

function appendNode(
  existing: FleetConfig | null,
  node: FleetNode
): FleetConfig {
  return parseConfig({ version: 1, nodes: [...(existing?.nodes ?? []), node] });
}

export async function addNode(
  path: string,
  node: FleetNode,
  apply: boolean
): Promise<FleetConfig> {
  if (!apply) return appendNode(await readRoster(path), node);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path);
  try {
    const roster = appendNode(await readRoster(path), node);
    await atomicWrite(path, roster);
    return roster;
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

async function acquireLock(path: string) {
  try {
    return await open(`${path}.lock`, 'wx', 0o600);
  } catch {
    throw new FleetUsageError(
      'Roster is locked or unwritable. Check permissions and concurrent writers; remove a stale .lock only after verifying no operation is running.'
    );
  }
}

async function atomicWrite(path: string, roster: FleetConfig): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(roster, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
  }
}
