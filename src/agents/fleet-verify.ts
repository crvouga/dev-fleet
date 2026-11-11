import { providerFailureCode } from './provider-errors';
import { verifyRoundTrip } from './round-trip';
import { proxyKey } from './secrets';
import type { Check } from '../types';
import { registry, type Selection } from './registry';
import { verifyProvider } from './verify';
import { fileURLToPath } from 'node:url';
import {
  cacheKey,
  cachedCheck,
  sourceKey,
  type VerifyCache,
} from './verify-cache';

/** The verifier's own code: changing how providers are checked re-verifies.
 * Resolved from the module URL: the published CLI loads this on Node, which has
 * no `import.meta.dir`.
 */
const VERIFIER_SOURCES = ['fleet-verify.ts', 'verify.ts', 'round-trip.ts'].map(
  (name) => fileURLToPath(new URL(name, import.meta.url))
);

/** Uses the selected gateway credential in this node's noninteractive environment.
 * Authentication/inference evidence does not certify native clients or paired T3.
 */
export async function verifyFleetProviders(
  node: string,
  cache: VerifyCache = {}
): Promise<Check[]> {
  let key: string;
  try {
    key = await proxyKey();
  } catch {
    return Object.keys(registry.proxy.routes).map((provider) => ({
      id: `provider:${provider}:authentication`,
      status: 'fail',
      summary: 'PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED',
      remedy: {
        action:
          'Restore this node’s existing Vault authorization and renewal. No model requests or native OAuth login were attempted.',
      },
    }));
  }

  // Warm runs reuse recent passes, but always prove this node's key still
  // authenticates to the live gateway; if it does not, verify everything.
  const live = await gatewayAuthenticates(key);
  const code = await sourceKey(VERIFIER_SOURCES);
  // Providers are independent upstream accounts: verify them concurrently so
  // the slowest one, not their sum, bounds the step. Order stays stable.
  return Promise.all(
    Object.entries(registry.proxy.routes).map(([provider, route]) =>
      cachedCheck(
        `provider-${node}-${provider}`,
        cacheKey(node, registry.proxy.endpoint, route, code),
        () => verifyRoute(node, provider, route, key),
        {
          ...cache,
          bypass: Boolean(cache.bypass) || !live,
          reuse: (check) => check.summary !== QUOTA_SUMMARY,
        }
      )
    )
  );
}

/** One cheap authenticated model listing: Vault key, proxy and route are live. */
async function gatewayAuthenticates(key: string): Promise<boolean> {
  try {
    const response = await fetch(registry.proxy.endpoint + '/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function verifyRoute(
  node: string,
  provider: string,
  route: { model: string; native: string | null; harness: string },
  key: string
): Promise<Check> {
  const selection: Selection = {
    node,
    profile: 'proxy',
    tool: (route.native ?? route.harness) as Selection['tool'],
    model: route.model,
  };
  try {
    const evidence = await verifyProvider(selection, true, key);
    await verifyRoundTrip(route.model, key);
    return {
      id: `provider:${provider}:inference`,
      status: evidence.inference === 'pass' ? 'pass' : 'fail',
      summary:
        'Gateway authentication, bounded inference, completed streaming and safe echo tool round trip verified from node environment. Native CLI/T3 execution is separate.',
    };
  } catch (error) {
    return inferenceFailure(provider, providerFailureCode(error));
  }
}

/** Rate limits and exhausted quota are expected on shared subscription
 * accounts: the gateway authenticated and routed the request, and the account
 * recovers on its own. They are not reported at all (a quiet pass).
 */
const QUOTA = new Set(['PROVIDER_RATE_LIMITED']);
/** Summary of the quiet pass; native session checks skip these accounts. */
export const QUOTA_SUMMARY =
  'Gateway authenticated and routed the request; the provider account is rate limited or out of quota and recovers on its own.';

/** Proxy routes whose provider account is out of quota in these checks. */
export function quotaLimited(checks: Check[]): Set<string> {
  return new Set(
    checks
      .filter((check) => check.summary === QUOTA_SUMMARY)
      .map((check) => check.id.split(':')[1]!)
  );
}

/** Other conditions owned by the upstream provider account (outage, billing)
 * do not mean this node is misconfigured: the gateway answered and routed the
 * request. They are warnings, so a provider outage never fails fleet-sync.
 */
const UPSTREAM: Record<string, string> = {
  PROVIDER_UPSTREAM_UNAVAILABLE:
    'The provider returned a server error through the gateway. Retry later; no fleet change is needed.',
  PROVIDER_MODEL_UNAVAILABLE:
    'The provider refused the declared model (often billing or account access). Fix the provider account, or change the model in agents/registry.json.',
  PROVIDER_TIMEOUT:
    'The provider did not answer within the bounded verification deadline. Retry later.',
};

export function inferenceFailure(provider: string, code: string): Check {
  if (QUOTA.has(code))
    return {
      id: `provider:${provider}:inference`,
      status: 'pass',
      summary: QUOTA_SUMMARY,
    };
  const upstream = UPSTREAM[code];
  return {
    id: `provider:${provider}:inference`,
    status: upstream ? 'warn' : 'fail',
    summary: code,
    remedy: {
      action:
        upstream ??
        `Verify unattended Vault access and the declared ${provider} model on the singleton gateway. Preserve OAuth state; do not log native auth on proxy clients.`,
    },
  };
}
