import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseConfig } from '../config';
import { FleetUsageError } from '../errors';
import type { FleetConfig, FleetNode } from '../types';
import { capabilities } from './options';
import type { CliOptions } from './options';
import { STATE_ROSTER, readRosterText, writeRosterText } from '../state/roster';
import {
  mutateState,
  stateContext,
  type Standing,
  type StateContext,
} from '../state/sync';

export async function readRoster(path: string): Promise<FleetConfig | null> {
  try {
    const text = await readRosterText(path);
    return text === null ? null : parseConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof FleetUsageError) throw error;
    throw new FleetUsageError(
      'Cannot read a valid roster. Use fleet-nodes --schema or choose --config PATH.'
    );
  }
}

/** The roster a fleet-sync needs: a missing one is an error, not an empty fleet. */
export async function loadRoster(path: string): Promise<FleetConfig> {
  let value: unknown;
  try {
    const text = await readRosterText(path);
    if (text === null) throw new Error();
    value = JSON.parse(text);
  } catch {
    throw new FleetUsageError(
      'Cannot read fleet config. Run devfleet fleet-node-add or use --config PATH.'
    );
  }
  return parseConfig(value);
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

export interface AddedNode {
  roster: FleetConfig;
  /** How the fleet state stands with the bucket; absent for a roster file. */
  standing?: Standing;
}

export async function addNode(
  path: string,
  node: FleetNode,
  apply: boolean,
  context: () => StateContext = stateContext
): Promise<AddedNode> {
  const save = async (): Promise<FleetConfig> => {
    const roster = appendNode(await readRoster(path), node);
    await writeRosterText(path, `${JSON.stringify(roster, null, 2)}\n`);
    return roster;
  };
  if (!apply) return { roster: appendNode(await readRoster(path), node) };
  if (path === STATE_ROSTER) {
    const { value, standing } = await mutateState(context(), save);
    return { roster: value, standing };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path);
  try {
    return { roster: await save() };
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
