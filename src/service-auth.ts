import { record } from './config';
import { copilotCheck } from './github/copilot';
import type { Check, CommandResult, Runner } from './types';

interface Service {
  id: string;
  command: string[];
  action: string;
  valid: (result: CommandResult) => boolean;
}
function json(result: CommandResult): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(result.stdout);
    return record(data) ? data : null;
  } catch {
    return null;
  }
}
export async function codingAuth(
  id: 'codex' | 'claude',
  run: Runner
): Promise<Check[]> {
  return [
    await serviceCheck(
      id === 'codex'
        ? {
            id,
            command: ['codex', 'login', 'status'],
            action: 'Run codex login on this computer as its operator.',
            valid: (result) =>
              /^Logged in using (ChatGPT|an API key|API key)\b/im.test(
                `${result.stdout}\n${result.stderr}`
              ),
          }
        : {
            id,
            command: ['claude', 'auth', 'status', '--json'],
            action: 'Run claude auth login on this computer as its operator.',
            valid: (result) => json(result)?.['loggedIn'] === true,
          },
      run
    ),
  ];
}

/** CLIs with no sign-in of their own to check, and why. Each says where
 * its access is proven instead; none is a silent skip.
 */
export const PROXY_ROUTED: Record<string, string> = {
  gemini:
    'gemini signs in through the CLI proxy and has no T3 launcher; provider:gemini:inference proves its route from this node.',
  opencode:
    'opencode signs in through the CLI proxy; agent:muse:session and the per-account agent:opencode sessions prove it from this node.',
};

export async function serviceAuth(run: Runner): Promise<Check[]> {
  const services: Service[] = [
    {
      id: 'railway',
      command: ['railway', 'whoami', '--json'],
      action: 'Run railway login on this computer.',
      valid: (result) => typeof json(result)?.['id'] === 'string',
    },
    {
      id: 'vercel',
      command: ['vercel', 'whoami'],
      action: 'Run vercel login on this computer.',
      valid: (result) =>
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(result.stdout.trim()),
    },
    {
      id: 'cloudflare',
      command: ['wrangler', 'whoami', '--json'],
      action: 'Run wrangler login on this computer.',
      valid: (result) => json(result)?.['loggedIn'] === true,
    },
    {
      id: 'aws',
      command: [
        'aws',
        'sts',
        'get-caller-identity',
        '--output',
        'json',
        '--no-cli-pager',
      ],
      action:
        'Select and authenticate the intended AWS profile on this computer.',
      valid: (result) =>
        typeof json(result)?.['Account'] === 'string' &&
        typeof json(result)?.['Arn'] === 'string',
    },
    {
      id: 'npm',
      command: ['npm', 'whoami', '--registry=https://registry.npmjs.org/'],
      action: 'Run npm login only if this computer should publish packages.',
      valid: (result) =>
        /^[a-z0-9][a-z0-9._-]{0,213}$/.test(result.stdout.trim()),
    },
  ];
  const checks: Check[] = [];
  for (const service of services) checks.push(await serviceCheck(service, run));
  checks.push(await copilotCheck(run));
  for (const [id, reason] of Object.entries(PROXY_ROUTED))
    checks.push({
      id: `auth:${id}`,
      status: 'skip',
      required: false,
      summary: `AUTH_NOT_SUPPORTED_ON_ROUTE: ${reason}`,
    });
  return checks;
}

async function serviceCheck(service: Service, run: Runner): Promise<Check> {
  const result = await run(service.command, { timeoutMs: 15_000 });
  const ok = result.ok && service.valid(result);
  return {
    id: `auth:${service.id}`,
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${service.id} reports an authenticated session in this process context; no credential or account output retained.`
      : `${service.id} login is missing or could not be verified (${result.reason}); no credential output retained.`,
    ...(!ok ? { remedy: { action: service.action } } : {}),
  };
}
