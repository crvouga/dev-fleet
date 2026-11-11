import { AgentConfigurationError } from './errors';

export class ProviderVerificationError extends AgentConfigurationError {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export function providerHttpFailure(status: number): ProviderVerificationError {
  const code =
    status === 401 || status === 403
      ? 'PROVIDER_AUTH_REJECTED'
      : status === 429
        ? 'PROVIDER_RATE_LIMITED'
        : status >= 500
          ? 'PROVIDER_UPSTREAM_UNAVAILABLE'
          : 'PROVIDER_PROTOCOL_REJECTED';
  return new ProviderVerificationError(
    code,
    'The gateway rejected a bounded verification request; response content is withheld.'
  );
}
const SAFE_CODES = new Set([
  'PROVIDER_AUTH_REJECTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UPSTREAM_UNAVAILABLE',
  'PROVIDER_PROTOCOL_REJECTED',
  'PROVIDER_MODEL_UNAVAILABLE',
  'PROVIDER_OUTPUT_UNVERIFIED',
  'PROVIDER_TOOL_RESULT_UNVERIFIED',
  'PROVIDER_EMPTY_RESPONSE',
  'PROVIDER_RESPONSE_LIMIT',
  'PROVIDER_TOOL_MISSING',
  'PROVIDER_TOOL_INVALID',
  'PROVIDER_TOOL_ARGUMENTS_INVALID',
  'PROVIDER_STREAM_INCOMPLETE',
]);
export function providerFailureCode(error: unknown): string {
  if (error instanceof ProviderVerificationError && SAFE_CODES.has(error.code))
    return error.code;
  if (error instanceof Error && SAFE_CODES.has(error.message))
    return error.message;
  if (error instanceof Error && error.name === 'TimeoutError')
    return 'PROVIDER_TIMEOUT';
  if (error instanceof TypeError) return 'PROVIDER_NETWORK_UNVERIFIED';
  if (error instanceof SyntaxError) return 'PROVIDER_RESPONSE_INVALID';
  return 'PROVIDER_ROUTE_UNVERIFIED';
}
