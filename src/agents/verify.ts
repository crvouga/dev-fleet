import {
  ProviderVerificationError,
  providerHttpFailure,
} from './provider-errors';
import { registry, type Selection } from './registry';
import { proxyKey } from './secrets';
import { VERIFY_OUTPUT_TOKENS } from './round-trip';

export async function verifyProvider(
  selection: Selection,
  smoke: boolean,
  credential?: string
) {
  if (selection.profile !== 'proxy')
    return {
      static: 'pass',
      reachability: 'unverified',
      authenticatedModels: 'unverified',
      inference: 'unverified',
      streaming: 'unverified',
      toolCalls: 'unverified',
      t3EndToEnd: 'unverified',
    };
  const key = credential ?? (await proxyKey());
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(registry.proxy.endpoint + '/v1/models', {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw providerHttpFailure(response.status);
  const data = (await response.json()) as { data?: Array<{ id: string }> };
  if (!data.data?.some((model) => model.id === selection.model))
    throw new ProviderVerificationError(
      'PROVIDER_MODEL_UNAVAILABLE',
      'Approved model is unavailable; review registry model selection.'
    );
  let inference = 'unverified';
  if (smoke) {
    const { path, body } = inferenceRequest(selection);
    const result = await fetch(registry.proxy.endpoint + path, {
      method: 'POST',
      headers: {
        ...headers,
        'anthropic-version': '2023-06-01',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok) throw providerHttpFailure(result.status);
    await validateOutput(result, selection.tool);
    inference = 'pass';
  }
  return {
    static: 'pass',
    reachability: 'pass',
    authenticatedModels: 'pass',
    inference,
    streaming: 'unverified',
    toolCalls: 'unverified',
    t3EndToEnd: 'unverified',
  };
}

async function validateOutput(
  result: Response,
  tool: Selection['tool']
): Promise<void> {
  const payload = (await result.json()) as {
    content?: unknown[];
    output?: unknown[];
    error?: unknown;
    candidates?: unknown[];
  };
  const output =
    tool === 'gemini' || tool === 'antigravity'
      ? payload.candidates
      : tool === 'claude'
        ? payload.content
        : payload.output;
  if (payload.error || !Array.isArray(output) || output.length === 0)
    throw new ProviderVerificationError(
      'PROVIDER_OUTPUT_UNVERIFIED',
      'Inference returned no output; inspect the provider locally.'
    );
}

/** Exact pinned clients use different wire protocols; model discovery is not inference.
 * Output uses the same ceiling as the round trip: reasoning models (Muse) spend
 * dozens of tokens before any text, so a tiny cap returns an empty output.
 */
export function inferenceRequest(selection: Selection): {
  path: string;
  body: object;
} {
  // Antigravity's CLI speaks the same Gemini generateContent protocol.
  if (selection.tool === 'gemini' || selection.tool === 'antigravity')
    return {
      path: `/v1beta/models/${encodeURIComponent(selection.model)}:generateContent`,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
        generationConfig: { maxOutputTokens: VERIFY_OUTPUT_TOKENS },
      },
    };
  if (selection.tool === 'claude')
    return {
      path: '/v1/messages',
      body: {
        model: selection.model,
        max_tokens: VERIFY_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      },
    };
  return {
    path: '/v1/responses',
    body: {
      model: selection.model,
      max_output_tokens: VERIFY_OUTPUT_TOKENS,
      input: 'Reply OK.',
    },
  };
}
