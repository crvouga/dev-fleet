import type { Check } from '../types';
import { desired, nodeId, paths } from './desired';
import type { Roster } from './accounts';
import { reconcileT3 } from './reconcile';
import { stablePath, stableWorkspace } from '../platform/t3-policy';

/** Every machine's T3 settings hold exactly the managed provider instances:
 * the fixed ones plus one per account signed in on the CLI proxy. T3 watches
 * its settings, so providers appear (and retired ones disappear) at once,
 * without a restart. Workers additionally lock the same instances through T3
 * administrator policy. The ownership-safe t3-apply engine preserves unrelated
 * settings and unmanaged instances; an existing unowned instance of the same
 * ID is reported, never overwritten.
 */
export async function machineProviders(
  id: string,
  workspace: string,
  apply: boolean,
  options: { t3Home?: string; roster?: Roster } = {}
): Promise<Check> {
  const remedy = {
    action:
      'Run devfleet t3-apply --dry-run on this machine and review any conflicting instance; adopt it with t3-apply --import ID only if it should be managed.',
  };
  try {
    const target = paths(options, workspace);
    // Providers launch from the stable path of the applied run checkout, not
    // from this revision's own directory, which a later sync prunes.
    const home = apply
      ? await stableWorkspace(workspace)
      : stablePath(workspace);
    const instances = await desired(
      target.definition,
      home,
      nodeId(id),
      options.roster
    );
    const plan = await reconcileT3(target, instances, { apply: false });
    const result =
      apply && plan.ok && plan.changed
        ? await reconcileT3(target, instances, {
            apply: true,
            planHash: plan.planHash,
          })
        : plan;
    if (!result.ok)
      return {
        id: 't3:providers',
        status: 'fail',
        summary: 'T3_PROVIDER_CONFLICT',
        remedy,
      };
    return result.changed && !apply
      ? {
          id: 't3:providers',
          status: 'warn',
          summary: 'T3_PROVIDERS_PENDING',
          remedy,
        }
      : {
          id: 't3:providers',
          status: 'pass',
          summary:
            'T3 on this machine offers exactly the managed provider instances every machine gets.',
        };
  } catch {
    return {
      id: 't3:providers',
      status: 'fail',
      summary: 'T3_PROVIDERS_UNVERIFIED',
      remedy,
    };
  }
}
