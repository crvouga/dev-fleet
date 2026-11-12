import type { FleetDefinition } from '../definition';
import type { SecretsProvider } from '../secrets';
import { githubPolicy } from './policy';

/** Where a node's GitHub token comes from. Every source is read through the
 * fleet's secrets provider, by the declared name `github-token`:
 * - `shared`: one token for the whole fleet;
 * - `per-node`: the node's own token (`github-token-<node>`), so revoking one
 *   node's token leaves every other node signed in.
 * gh on the node holds the token it was given; git and every other tool ask
 * gh for it each time (`gh auth git-credential`), so a replaced token reaches
 * them without restarting anything.
 */
export function githubCredential(
  definition: FleetDefinition,
  node: string,
  secret: SecretsProvider
): () => Promise<string | null> {
  const perNode = githubPolicy(definition).credential === 'per-node';
  return () => secret('github-token', perNode ? node : undefined);
}
