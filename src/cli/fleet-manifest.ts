import { readFile } from 'node:fs/promises';
import { FleetUsageError } from '../errors';
import { fleet } from '../fleet-config';
import { declaredFor, workerFeatures } from '../worker-features';
import { runCommand } from '../runner';
import type { Runner } from '../types';
import {
  declaredDifferences,
  diffManifests,
  manifestCheck,
  manifestDigest,
  measureManifest,
  ubuntuPolicy,
  type WorkerManifest,
} from '../worker-manifest';
import type { CommandOutcome } from './contracts';
import { readRoster } from './roster';

export interface FleetManifestOptions {
  id?: string;
  /** A manifest from a fresh build of the same revision (fleet-manifest
   * --json of that build) to compare the worker with.
   */
  reference?: string;
}

export interface FleetManifestServices {
  run: Runner;
  roster: string;
  root?: string;
}

export const manifestServices = (roster: string): FleetManifestServices => ({
  run: runCommand,
  roster,
});

async function reference(path: string): Promise<WorkerManifest> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      manifest?: WorkerManifest;
    } & Partial<WorkerManifest>;
    const manifest = value.manifest ?? (value as WorkerManifest);
    if (manifest.version !== 1 || !manifest.packages) throw new Error();
    return manifest;
  } catch {
    throw new FleetUsageError(
      '--reference must name a manifest written by devfleet fleet-manifest --json.'
    );
  }
}

/** Read-only: measures what an enrolled worker is made of, and the check
 * worker:manifest against the declared pins and, with --reference, a fresh
 * build of the same revision.
 */
export async function fleetManifest(
  options: FleetManifestOptions,
  services: FleetManifestServices
): Promise<CommandOutcome> {
  const roster = await readRoster(services.roster);
  const node = roster?.nodes.find((entry) => entry.id === options.id);
  if (!node) throw new FleetUsageError('--id must name an enrolled worker.');
  const fresh = options.reference
    ? await reference(options.reference)
    : undefined;
  // A worker is measured against what its own features install.
  const policy = declaredFor(
    await ubuntuPolicy(services.root),
    workerFeatures(fleet, node.id)
  );
  const measured = await measureManifest(node, services.run, policy);
  if ('check' in measured)
    return {
      exitCode: 1,
      data: {
        version: 1,
        command: 'fleet-manifest',
        ok: false,
        node: node.id,
        checks: [measured.check],
      },
    };
  const { manifest } = measured;
  const differences = [
    ...declaredDifferences(manifest, policy),
    ...(fresh ? diffManifests(fresh, manifest) : []),
  ];
  const check = manifestCheck(differences);
  const digest = manifestDigest(manifest);
  return {
    exitCode: check.status === 'fail' ? 1 : 0,
    data: {
      version: 1,
      command: 'fleet-manifest',
      ok: check.status !== 'fail',
      node: node.id,
      digest,
      manifest,
      differences,
      checks: [check],
    },
    text: [
      `${node.id}: ${Object.keys(manifest.packages).length} packages, ${Object.keys(manifest.tools).length} tools, digest ${digest}`,
      `${check.status.toUpperCase()} ${check.id}: ${check.summary}`,
    ].join('\n'),
  };
}
