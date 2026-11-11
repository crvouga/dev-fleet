import { AgentConfigurationError } from './errors';
import { secret } from '../fleet-config';

/** The key every node presents to the CLI proxy, from this fleet's secrets
 * provider with this node's own access.
 */
export async function proxyKey(): Promise<string> {
  const value = await secret('proxy-client-key');
  if (value) return value;
  throw new AgentConfigurationError(
    "Required secret unavailable: proxy-client-key. Restore this node's access to the fleet's secrets provider (see `secrets` in the fleet configuration)."
  );
}
