import {
  accountSlug as slug,
  discoverAccounts,
  type Account,
} from '../agents/accounts';
import { proxyKey } from '../agents/secrets';

export type Roster = () => Promise<Account[]>;

/** The accounts signed in on the CLI proxy, read with this node's own key.
 * Throws when the proxy does not answer, so providers are never dropped
 * because the roster was unreadable.
 */
export const proxyAccounts: Roster = async () =>
  discoverAccounts(await proxyKey());

/** How T3 runs each tool for one account. The launcher pins every request to
 * the account named by WS_AGENT_ACCOUNT; no credential is ever placed here.
 */
const TOOLS: Record<
  string,
  { driver: string; label: string; config: Record<string, string> }
> = {
  claude: {
    driver: 'claudeAgent',
    label: 'Claude',
    config: {
      binaryPath: '${workspace}/agents/claude-proxy',
      homePath: '${agents}/${node}/claude/account-${account}',
    },
  },
  codex: {
    driver: 'codex',
    label: 'Codex',
    config: {
      binaryPath: '${workspace}/agents/codex-proxy.ts',
      homePath: '${agents}/${node}/codex/account-${account}',
    },
  },
  opencode: {
    driver: 'opencode',
    label: 'AntiGravity',
    config: {
      binaryPath: '${workspace}/agents/opencode-proxy.ts',
    },
  },
};

/** The T3 instance of one account, and the T3 driver that runs its tool. */
export const accountInstanceId = (account: Account): string =>
  `personal_${slug(account.prefix)}`.slice(0, 64);
export const accountDriver = (tool: string): string | undefined =>
  TOOLS[tool]?.driver;

/** One `<Provider> <account email>` instance per signed-in account, identical
 * on every machine because every machine reads the same proxy.
 */
export function accountInstances(
  accounts: Account[],
  variables: Record<string, string>
): Record<string, unknown> {
  const instances: Record<string, unknown> = {};
  for (const account of accounts) {
    const tool = TOOLS[account.tool];
    if (!tool) continue;
    const values: Record<string, string> = {
      ...variables,
      account: slug(account.email),
    };
    instances[accountInstanceId(account)] = {
      driver: tool.driver,
      displayName: `${tool.label} ${account.email}`,
      enabled: true,
      config: Object.fromEntries(
        Object.entries(tool.config).map(([key, value]) => [
          key,
          value.replace(/\$\{(\w+)\}/g, (_, name: string) => values[name]!),
        ])
      ),
      environment: [
        { name: 'WS_AGENT_NODE', value: variables['node'], sensitive: false },
        { name: 'WS_AGENT_ACCOUNT', value: account.email, sensitive: false },
      ],
    };
  }
  return instances;
}
