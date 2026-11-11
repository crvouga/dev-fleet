import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { record } from './config';
import {
  fileHash,
  manifestHash,
  sidecarHash,
  INPUT_FILES,
  FINGERPRINT_FILES,
} from './input-hashes';
import type { Fingerprint, Runner, Check } from './types';

const RECEIPT = 'node_modules/.fleet-sync.json';

export async function fingerprint(
  root: string,
  run: Runner
): Promise<Fingerprint> {
  const files: Fingerprint['files'] = {};
  for (const name of INPUT_FILES)
    files[name] = await fileHash(join(root, name));
  files['workspace-manifests'] = await manifestHash(root);
  files['mise-sidecars'] = await sidecarHash(root);
  const head = await run(['git', 'rev-parse', 'HEAD'], { cwd: root });
  return {
    head:
      head.ok && /^[a-f0-9]{40,64}\s*$/.test(head.stdout)
        ? head.stdout.trim()
        : null,
    files,
  };
}

export async function dependencyCheck(
  root: string,
  current: Fingerprint
): Promise<Check> {
  const remedy = {
    action:
      'Review devfleet fleet-repair --repair workspace, then explicitly apply a frozen toolchain/dependency sync.',
  };
  try {
    const receipt: unknown = JSON.parse(
      await readFile(join(root, RECEIPT), 'utf8')
    );
    const matches =
      record(receipt) &&
      receipt['version'] === 1 &&
      JSON.stringify(receipt['files']) === JSON.stringify(current.files);
    return {
      id: 'dependencies',
      status: matches ? 'pass' : 'fail',
      summary: matches
        ? 'Last successful frozen sync matches input hashes; not a full integrity audit.'
        : 'Dependency sync receipt is stale or invalid.',
      ...(matches ? {} : { remedy }),
    };
  } catch {
    return {
      id: 'dependencies',
      status: 'warn',
      summary: 'No frozen-sync receipt; installed dependencies are unverified.',
      remedy,
    };
  }
}

export async function writeReceipt(
  root: string,
  current: Fingerprint
): Promise<void> {
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(
    join(root, RECEIPT),
    JSON.stringify({ version: 1, files: current.files }),
    { mode: 0o600 }
  );
}

export function compareFingerprints(
  expected: Fingerprint,
  actual: Fingerprint
): Check[] {
  return [
    compare('revision', expected.head, actual.head),
    ...FINGERPRINT_FILES.map((name) =>
      compare(
        `sync:${name}`,
        expected.files[name] ?? null,
        actual.files[name] ?? null
      )
    ),
  ];
}

function compare(
  id: string,
  expected: string | null,
  actual: string | null
): Check {
  const known = expected !== null && actual !== null;
  const matches = known && expected === actual;
  return {
    id,
    status: matches ? 'pass' : 'fail',
    summary: matches
      ? 'Matches the manager checkout.'
      : known
        ? 'Differs from the manager checkout.'
        : 'Cannot verify; reference or node input is missing.',
    ...(matches
      ? {}
      : {
          remedy: {
            action:
              'Reconcile branches/lockfiles; review devfleet fleet-sync for the approved revision. Never reset a working tree.',
          },
        }),
  };
}
