import { join } from 'node:path';
import type { Check } from '../types';
import { accountDriver, accountInstanceId, type Roster } from './accounts';
import type { Account } from '../agents/accounts';
import { object, read } from './files';

/** The models T3 offers for one instance: the catalogue T3 keeps for its
 * driver (userdata/model-manifest.json) and any custom models the instance
 * adds. Null when T3 has no list for the driver: it asks the tool itself.
 */
function offered(
  manifest: Record<string, unknown>,
  instance: unknown,
  driver: string
): string[] | null {
  const catalogue = object(
    JSON.stringify(
      object(JSON.stringify(manifest['manifest'] ?? {}))['currentModels'] ?? {}
    )
  )[driver];
  const config =
    instance && typeof instance === 'object'
      ? (instance as { config?: { customModels?: unknown } }).config
      : undefined;
  const custom = Array.isArray(config?.customModels)
    ? config.customModels.flatMap((model: unknown) =>
        typeof model === 'string'
          ? [model]
          : model &&
              typeof model === 'object' &&
              typeof (model as { slug?: unknown }).slug === 'string'
            ? [(model as { slug: string }).slug]
            : []
      )
    : [];
  if (!Array.isArray(catalogue) && !custom.length) return null;
  return [
    ...new Set([
      ...(Array.isArray(catalogue)
        ? catalogue.filter(
            (model): model is string => typeof model === 'string'
          )
        : []),
      ...custom,
    ]),
  ].sort();
}

/** `t3:models`: for every account instance the fleet manages, T3 offers only
 * models the proxy serves for that account, and every required model is both
 * served and offered. A report names tools and models, never an account.
 */
export async function modelsCheck(options: {
  t3Home: string;
  roster: Roster;
  required?: Record<string, string[]>;
}): Promise<Check> {
  const remedy = (action: string) => ({ remedy: { action } });
  let accounts;
  let settings;
  let manifest;
  try {
    accounts = await options.roster();
    settings = object(
      await read(join(options.t3Home, 'userdata/settings.json'))
    );
    manifest = object(
      await read(join(options.t3Home, 'userdata/model-manifest.json'))
    );
  } catch {
    return {
      id: 't3:models',
      status: 'warn',
      summary: 'T3_MODELS_UNVERIFIED',
      ...remedy(
        'The proxy’s model list or T3’s settings could not be read on this machine. Check that the CLI proxy answers and T3 has started once, then run fleet-sync.'
      ),
    };
  }
  const problems = mismatches(
    accounts,
    object(JSON.stringify(settings['providerInstances'] ?? {})),
    manifest,
    options.required ?? {}
  );
  if (problems.size)
    return {
      id: 't3:models',
      status: 'warn',
      summary: 'T3_MODELS_MISMATCH',
      ...remedy(
        `${[...problems].sort().join('; ')}. Serve the model on the CLI proxy, or remove it from t3.requiredModels in fleet.json; a model the proxy no longer serves fails when it is chosen in T3.`
      ),
    };
  return {
    id: 't3:models',
    status: 'pass',
    summary:
      'Every model T3 offers for a managed account is one the proxy serves for it, and every required model is offered.',
  };
}

/** What is wrong with the models of each managed account instance. */
function mismatches(
  accounts: Account[],
  instances: Record<string, unknown>,
  manifest: Record<string, unknown>,
  required: Record<string, string[]>
): Set<string> {
  const problems = new Set<string>();
  for (const account of accounts) {
    const driver = accountDriver(account.tool);
    const id = accountInstanceId(account);
    if (!driver || !Object.hasOwn(instances, id)) continue;
    const offers = offered(manifest, instances[id], driver);
    for (const model of offers ?? [])
      if (!account.models.includes(model))
        problems.add(
          `${account.tool}: T3 offers ${model}, which the proxy does not serve`
        );
    for (const model of required[account.tool] ?? []) {
      if (!account.models.includes(model))
        problems.add(
          `${account.tool}: the proxy does not serve the required ${model}`
        );
      else if (offers && !offers.includes(model))
        problems.add(
          `${account.tool}: T3 does not offer the required ${model}`
        );
    }
  }
  return problems;
}
