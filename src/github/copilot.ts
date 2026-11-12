import type { Check, Runner } from '../types';
import { activeToken } from './sync';

/** The kinds of GitHub token Copilot CLI accepts: OAuth (`gho_`), GitHub App
 * user (`ghu_`) and fine-grained personal (`github_pat_`) tokens. A classic
 * personal token (`ghp_`) is refused by Copilot.
 */
const ACCEPTED = /^(gho_|ghu_|github_pat_)/;
const CLASSIC = /^ghp_/;

/** Copilot CLI signs in with the node's GitHub credential: with no token of
 * its own in the environment and no `copilot login`, it uses the token gh
 * holds. So the node's GitHub sign-in is Copilot's, and nothing is signed in
 * per node by hand. Only the kind of the token is read, never the token.
 */
export async function copilotCheck(run: Runner): Promise<Check> {
  const installed = await run(['copilot', '--version'], { timeoutMs: 15_000 });
  if (!installed.ok)
    return {
      id: 'auth:copilot',
      status: 'skip',
      required: false,
      summary: 'Copilot CLI is not installed in this process context.',
    };
  const token = await activeToken(run, 15_000);
  if (token === null)
    return {
      id: 'auth:copilot',
      status: 'fail',
      summary:
        'not-signed-in: this node holds no GitHub credential for Copilot CLI to use.',
      remedy: {
        action:
          'Run fleet-sync: it signs the node in to GitHub from the stored credential, and Copilot CLI uses that sign-in. No copilot login is needed.',
      },
    };
  if (CLASSIC.test(token) || !ACCEPTED.test(token))
    return {
      id: 'auth:copilot',
      status: 'fail',
      summary:
        'COPILOT_TOKEN_UNSUPPORTED: the node’s GitHub token is of a kind Copilot CLI refuses (a classic personal access token).',
      remedy: {
        action:
          'Store a fine-grained token with the Copilot Requests permission as github-token and run fleet-sync; every node and Copilot CLI then use it.',
      },
    };
  return {
    id: 'auth:copilot',
    status: 'pass',
    summary:
      'Copilot CLI uses this node’s GitHub sign-in, whose token is of a kind Copilot accepts. Copilot entitlement of the account is not measured here; no prompt was made.',
  };
}
