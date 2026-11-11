import { AgentConfigurationError } from './errors';
import { registry } from './registry';

/** One signed-in provider account on the proxy, offered through one tool. */
export type Account = {
  tool: string;
  email: string;
  /** Models named `<prefix>/<model>` are served only by this account. */
  prefix: string;
  /** Every model the account serves, preferred default first. */
  models: string[];
};

type Route = { provider: string; models: string[] };
const ROUTES = registry.proxy.accounts as Record<string, Route>;
const EMAIL = /^[^\s@/]{1,64}@[^\s@/]{1,255}$/;

/** Stable file and instance name for an account. */
export const accountSlug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** The proxy gives each account credential the prefix `<type>-<email>`. */
export function accountPrefix(tool: string, email: string): string {
  const route = ROUTES[tool];
  if (!route || !EMAIL.test(email))
    throw new AgentConfigurationError(
      'Unknown provider account; T3 offers only accounts signed in on the CLI proxy.'
    );
  return `${route.provider}-${email}`;
}

/** Accounts are never declared in source: the proxy lists a prefixed copy of
 * each model for every signed-in credential, and that list is the roster.
 */
export function accountsFrom(modelIds: string[]): Account[] {
  const accounts: Account[] = [];
  for (const [tool, route] of Object.entries(ROUTES)) {
    const served = new Map<string, string[]>();
    for (const id of modelIds) {
      const slash = id.indexOf('/');
      const owner = id.slice(0, slash);
      if (slash < 0 || !owner.startsWith(`${route.provider}-`)) continue;
      const email = owner.slice(route.provider.length + 1);
      if (!EMAIL.test(email)) continue;
      served.set(email, [...(served.get(email) ?? []), id.slice(slash + 1)]);
    }
    for (const email of [...served.keys()].sort())
      accounts.push({
        tool,
        email,
        prefix: `${route.provider}-${email}`,
        models: preferred(served.get(email)!.sort(), route.models),
      });
  }
  return accounts;
}

const preferred = (models: string[], first: string[]) => [
  ...first.filter((model) => models.includes(model)),
  ...models.filter((model) => !first.includes(model)),
];

/** Reads the roster with this node's own proxy key. Throws when the proxy does
 * not answer: an unknown roster must never read as "no accounts".
 */
export async function discoverAccounts(
  key: string,
  send: typeof fetch = fetch
): Promise<Account[]> {
  const response = await send(registry.proxy.endpoint + '/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new AgentConfigurationError('The CLI proxy did not list its models.');
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  if (!Array.isArray(body.data))
    throw new AgentConfigurationError('The CLI proxy did not list its models.');
  return accountsFrom(
    body.data.flatMap((model) =>
      typeof model.id === 'string' ? [model.id] : []
    )
  );
}
