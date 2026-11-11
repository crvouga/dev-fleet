import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FleetUsageError } from '../errors';
import { canonical, object, read, safePath, write } from './files';
import { ownership, planT3, readOwnership, type T3Paths } from './plan';

export async function reconcileT3(
  paths: T3Paths,
  desired: Record<string, unknown>,
  options: { apply: boolean; planHash?: string }
) {
  if (!options.apply) return report(await planT3(paths, desired), false);
  return locked(paths, async () => {
    const plan = await planT3(paths, desired);
    if (options.planHash && options.planHash !== plan.planHash)
      throw new FleetUsageError(
        'T3 plan is stale. Run devfleet t3-apply --dry-run again.'
      );
    if (plan.changes.some((change) => change.action === 'conflict'))
      throw new FleetUsageError(
        'T3 instance already exists without ownership. Review it and use devfleet t3-apply --import ID.'
      );
    if (!plan.settingsChanged && !plan.stateChanged) return report(plan, true);
    await persist(paths, desired, plan);
    const verified = await planT3(paths, desired);
    if (verified.settingsChanged || verified.stateChanged)
      throw new FleetUsageError(
        'T3 changed after apply; reconciliation is incomplete. Replan and retry.'
      );
    return report(plan, true);
  });
}

export async function importT3(paths: T3Paths, id: string) {
  return locked(paths, async () => {
    const raw = await read(paths.settings);
    const instances = object(
      JSON.stringify(object(raw)['providerInstances'] ?? {})
    );
    if (!Object.hasOwn(instances, id))
      throw new FleetUsageError('T3 import requires an existing instance ID.');
    const state = await read(paths.state);
    const owned = readOwnership(state, paths.settings);
    if (!owned.includes(id)) {
      if (state !== null) await write(`${paths.state}.backup`, state);
      if ((await read(paths.settings)) !== raw)
        throw new FleetUsageError('T3 changed during import; retry.');
      await write(
        paths.state,
        canonical(ownership(paths.settings, [...owned, id])) + '\n'
      );
    }
    return { version: 1, ok: true, imported: id, changed: !owned.includes(id) };
  });
}

async function locked<T>(paths: T3Paths, action: () => Promise<T>): Promise<T> {
  await safePath(paths.state);
  await mkdir(dirname(paths.state), { recursive: true, mode: 0o700 });
  const lock = `${paths.state}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new FleetUsageError(
      'Another personal T3 operation holds the lock. Inspect interrupted operations before removing a stale lock.'
    );
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

function report(plan: Awaited<ReturnType<typeof planT3>>, applied: boolean) {
  return {
    version: 1,
    ok: !plan.changes.some((change) => change.action === 'conflict'),
    applied,
    changed: plan.settingsChanged || plan.stateChanged,
    planHash: plan.planHash,
    changes: plan.changes,
    runtime:
      'T3 watches settings.json; new sessions use the reconciled instances. Active sessions are not restarted.',
  };
}

async function persist(
  paths: T3Paths,
  desired: Record<string, unknown>,
  plan: Awaited<ReturnType<typeof planT3>>
) {
  // Keep a private recovery copy. Contents, environment and secret references never enter reports.
  if (plan.raw !== null && plan.settingsChanged)
    await write(`${paths.state}.settings-backup`, plan.raw);
  if (plan.stateRaw !== null)
    await write(`${paths.state}.backup`, plan.stateRaw);
  if (
    (await read(paths.settings)) !== plan.raw ||
    (await read(paths.state)) !== plan.stateRaw
  )
    throw new FleetUsageError(
      'T3 configuration changed during apply. Replan and retry.'
    );
  // Intent first: retry after interruption can finish creates/deletes without importing them.
  const previous = readOwnership(plan.stateRaw, paths.settings);
  await write(
    paths.state,
    canonical(
      ownership(paths.settings, [
        ...new Set([...previous, ...Object.keys(desired)]),
      ])
    ) + '\n'
  );
  if (plan.settingsChanged) {
    if ((await read(paths.settings)) !== plan.raw)
      throw new FleetUsageError(
        'T3 changed during apply. Ownership intent was saved; replan and retry.'
      );
    await write(paths.settings, JSON.stringify(plan.settings, null, 2) + '\n');
  }
  await write(paths.state, canonical(plan.state) + '\n');
}
