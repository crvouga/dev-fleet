import { providerHttpFailure } from './provider-errors';
import { randomUUID } from 'node:crypto';
import { registry } from './registry';
import { record } from '../config';

/** Reasoning models spend output tokens thinking before any text or tool call,
 * so a tight cap ends the response without the tool call or text being
 * verified. Prompts are tiny; this is a ceiling, not an expected length.
 */
export const VERIFY_OUTPUT_TOKENS = 1024;

/** Supported OpenAI Responses harness route. The only tool is a local echo;
 * model output can never select a command, file, URL or other side effect.
 */
export async function verifyRoundTrip(
  model: string,
  key: string,
  request = fetch
): Promise<void> {
  await verifyStream(model, key, request);
  const nonce = randomUUID();
  const tool = {
    type: 'function',
    name: 'fleet_echo',
    description: 'Return the provided verification nonce.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string', enum: [nonce] } },
      required: ['nonce'],
      additionalProperties: false,
    },
    strict: true,
  };
  const prompt = {
    role: 'user',
    content: `Call fleet_echo with nonce ${nonce}, then reply with its result.`,
  };
  const response = await call(
    model,
    key,
    {
      input: [prompt],
      tools: [tool],
      tool_choice: { type: 'function', name: 'fleet_echo' },
      max_output_tokens: VERIFY_OUTPUT_TOKENS,
    },
    request
  );
  const payload: unknown = JSON.parse(await boundedText(response));
  const invocation = validateInvocation(payload, nonce);
  const final = await call(
    model,
    key,
    {
      input: [
        prompt,
        invocation,
        {
          type: 'function_call_output',
          call_id: invocation.call_id,
          output: nonce,
        },
      ],
      tools: [tool],
      tool_choice: 'none',
      max_output_tokens: VERIFY_OUTPUT_TOKENS,
    },
    request
  );
  const completed: unknown = JSON.parse(await boundedText(final));
  if (
    !record(completed) ||
    completed['status'] !== 'completed' ||
    !Array.isArray(completed['output']) ||
    !JSON.stringify(completed['output']).includes(nonce)
  )
    throw new Error('PROVIDER_TOOL_RESULT_UNVERIFIED');
}
async function call(
  model: string,
  key: string,
  body: object,
  request: typeof fetch
): Promise<Response> {
  const response = await request(registry.proxy.endpoint + '/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, ...body }),
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw providerHttpFailure(response.status);
  return response;
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('PROVIDER_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) throw new Error('PROVIDER_RESPONSE_LIMIT');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
function validateInvocation(
  payload: unknown,
  nonce: string
): {
  type: 'function_call';
  call_id: string;
  name: 'fleet_echo';
  arguments: string;
} {
  if (!record(payload)) throw new Error('PROVIDER_TOOL_MISSING');
  if (!Array.isArray(payload['output']))
    throw new Error('PROVIDER_TOOL_MISSING');
  const calls = payload['output'].filter(
    (item) => record(item) && item['type'] === 'function_call'
  );
  const call = calls[0];
  if (
    calls.length !== 1 ||
    !record(call) ||
    call['name'] !== 'fleet_echo' ||
    !stringFields(call, ['call_id', 'arguments'])
  )
    throw new Error('PROVIDER_TOOL_INVALID');
  const args: unknown = JSON.parse(String(call['arguments']));
  if (
    !record(args) ||
    Object.keys(args).length !== 1 ||
    args['nonce'] !== nonce
  )
    throw new Error('PROVIDER_TOOL_ARGUMENTS_INVALID');
  return {
    type: 'function_call',
    name: 'fleet_echo',
    call_id: String(call['call_id']),
    arguments: String(call['arguments']),
  };
}

async function verifyStream(
  model: string,
  key: string,
  request: typeof fetch
): Promise<void> {
  const response = await call(
    model,
    key,
    {
      input: 'Reply OK.',
      stream: true,
      max_output_tokens: VERIFY_OUTPUT_TOKENS,
    },
    request
  );
  const body = await boundedText(response);
  const events: unknown[] = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line));
  const types = events.filter(record).map((event) => event['type']);
  if (
    !types.includes('response.completed') ||
    !types.includes('response.output_text.delta') ||
    types.includes('response.failed') ||
    types.includes('error')
  )
    throw new Error('PROVIDER_STREAM_INCOMPLETE');
}

function stringFields(
  value: Record<string, unknown>,
  fields: string[]
): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}
