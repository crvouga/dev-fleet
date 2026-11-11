import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint, writeReceipt } from './fingerprint';
import type { Runner, Check, Fingerprint } from './types';

export function syncPlan(pull: boolean): string[] {
  return [
    'Validate the checkout and shared input files; invalidate any prior sync receipt.',
    ...(pull
      ? [
          'Refuse dirty or detached checkouts; git pull --ff-only (no reset, stash, force or rebase).',
        ]
      : []),
    'Run mise exec --locked bun -- bun bootstrap/setup.ts --non-interactive (shared tools, user mise/PATH, frozen dependencies).',
    'Record input hashes only after every step succeeds.',
    'Run fleet-status afterward; workstation/provider configuration and logins remain explicit ws/operator actions.',
  ];
}

export async function syncWorkspace(
  root: string,
  pull: boolean,
  run: Runner
): Promise<Check[]> {
  const before = await fingerprint(root, run);
  if (!completeFingerprint(before)) {
    return failed(
      'Not a complete workspace checkout. Follow fleet-nodes --onboard first.'
    );
  }
  if (pull) {
    const dirty = await run(['git', 'status', '--porcelain'], { cwd: root });
    const branch = await run(['git', 'symbolic-ref', '--quiet', 'HEAD'], {
      cwd: root,
    });
    if (!dirty.ok || dirty.stdout.trim() || !branch.ok)
      return failed(
        'Refusing pull: dirty, detached, or unreadable checkout. Reconcile manually.'
      );
  }
  await unlink(join(root, 'node_modules/.fleet-sync.json')).catch(
    () => undefined
  );
  if (pull) {
    const result = await run(['git', 'pull', '--ff-only'], {
      cwd: root,
      timeoutMs: 120_000,
    });
    if (!result.ok)
      return failed(
        'Fast-forward pull failed. Inspect upstream/network/auth manually; nothing was reset.'
      );
  }
  const expected = await fingerprint(root, run);
  const result = await run(
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
    { cwd: root, timeoutMs: 1_200_000 }
  );
  if (!result.ok)
    return failed(
      `Shared toolchain/dependency sync failed (${result.reason}). Inspect setup locally; partial installs are possible.`
    );
  const after = await fingerprint(root, run);
  if (JSON.stringify(expected) !== JSON.stringify(after))
    return failed(
      'Checkout inputs changed during sync. Retry from a stable checkout.'
    );
  await writeReceipt(root, after);
  return [
    {
      id: 'sync',
      status: 'pass',
      summary:
        'Shared setup succeeded; frozen-sync receipt recorded. Auth and live connectivity still need doctor checks.',
    },
  ];
}

function failed(summary: string): Check[] {
  return [
    {
      id: 'sync',
      status: 'fail',
      summary,
      remedy: {
        action:
          'Resolve locally using docs/machine-setup.md, then review and retry devfleet fleet-repair --repair workspace.',
      },
    },
  ];
}

function completeFingerprint(value: Fingerprint): boolean {
  return value.head !== null && Object.values(value.files).every(Boolean);
}
