import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check, Runner } from '../types';
import { pinnedPath } from './toolchain';
import { registry } from './registry';
import {
  cacheKey,
  cachedCheck,
  sourceKey,
  type VerifyCache,
} from './verify-cache';

const PROMPT = 'Reply with exactly: OK';

/** Every agent T3 offers on every node, launched exactly as T3 launches it:
 * through the tracked wrapper that injects the shared credential. `pin` names
 * the mise.toml tool whose locked version the installed binary must report.
 */
export const NATIVE_AGENTS = [
  {
    name: 'claude',
    binary: 'claude',
    pin: 'claude',
    wrapper: 'claude-proxy.ts',
    args: ['-p', PROMPT],
  },
  {
    name: 'codex',
    binary: 'codex',
    pin: 'codex',
    wrapper: 'codex-proxy.ts',
    args: ['exec', '--skip-git-repo-check', PROMPT],
  },
  {
    name: 'grok',
    binary: 'grok',
    pin: 'http:grok',
    wrapper: 'grok-proxy.ts',
    args: ['-p', PROMPT],
  },
  {
    name: 'antigravity',
    binary: 'antigravity',
    pin: 'http:antigravity',
    wrapper: 'antigravity-proxy.ts',
    args: [
      '-p',
      PROMPT,
      '--model',
      'Gemini 3.8 Flash (High)',
      '--print-timeout',
      '90s',
    ],
  },
  {
    name: 'muse',
    binary: 'opencode',
    pin: 'aqua:anomalyco/opencode',
    wrapper: 'opencode-proxy.ts',
    args: ['run', '--model', 'personal_proxy/devin/muse-wonder-1-0', PROMPT],
  },
] as const;

type Agent = (typeof NATIVE_AGENTS)[number];

/** Same versions everywhere (from the shared mise.lock) and a working signed-in
 * session through each T3 launcher. Agents run concurrently and are bounded.
 */
export async function verifyNativeAgents(
  node: string,
  workspace: string,
  run: Runner,
  options: {
    /** Proxy routes already found out of quota; their sessions are not run. */
    outOfQuota?: Set<string>;
    cache?: VerifyCache;
  } = {}
): Promise<Check[]> {
  const { outOfQuota = new Set<string>(), cache = {} } = options;
  const pins = parsePins(await readFile(join(workspace, 'mise.toml'), 'utf8'));
  const cwd = await mkdtemp(join(tmpdir(), 'fleet-agents-'));
  try {
    const results = await Promise.all(
      NATIVE_AGENTS.map(async (agent) => [
        await versionCheck(agent, pins[agent.pin], run),
        outOfQuota.has(agent.name)
          ? quotaPass(agent)
          : await cachedCheck(
              `agent-${node}-${agent.name}`,
              cacheKey(
                node,
                agent,
                pins[agent.pin] ?? '',
                registry,
                await sourceKey(launcherSources(workspace, agent))
              ),
              () => sessionCheck(agent, { node, workspace, cwd }, run),
              cache
            ),
      ])
    );
    return results.flat();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Reads `tool = "x"` and `"tool" = { version = "x", ... }` pins. */
export function parsePins(source: string): Record<string, string> {
  const pins: Record<string, string> = {};
  const pattern =
    /^"?([A-Za-z0-9:@/._-]+)"?\s*=\s*(?:"([^"]+)"|\{[^\n]*?\bversion\s*=\s*"([^"]+)")/gm;
  for (const match of source.matchAll(pattern))
    pins[match[1]!] = (match[2] ?? match[3])!;
  return pins;
}

/** Self-healing: a binary that drifted from the lock (a vendor self-updater
 * rewrote it) is reinstalled from the locked artifact, then checked again.
 */
async function versionCheck(
  agent: Agent,
  pin: string | undefined,
  run: Runner
): Promise<Check> {
  const matches = async () => {
    const result = await run([agent.binary, '--version'], {
      env: { PATH: pinnedPath() },
      timeoutMs: 30_000,
    });
    return Boolean(pin) && result.ok && result.stdout.includes(pin!);
  };
  let ok = await matches();
  if (!ok && pin) {
    await run(
      ['mise', 'install', '--locked', '--force', `${agent.pin}@${pin}`],
      {
        timeoutMs: 600_000,
      }
    );
    ok = await matches();
  }
  return {
    id: `agent:${agent.name}:version`,
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${agent.binary} ${pin} matches the shared toolchain lock.`
      : 'AGENT_VERSION_MISMATCH',
    ...(ok
      ? {}
      : {
          remedy: {
            action: `Every node runs the ${agent.binary} pinned in mise.toml/mise.lock; reinstalling it from the lock failed. Inspect mise install --locked ${agent.pin} on this node; never install it with a vendor self-updater.`,
          },
        }),
  };
}

/** Quota is the account's, not the node's: no warning (as for providers). */
function quotaPass(agent: Agent): Check {
  return {
    id: `agent:${agent.name}:session`,
    status: 'pass',
    summary: `The shared ${agent.name} account is rate limited or out of quota; its session is checked again once it recovers.`,
  };
}

async function sessionCheck(
  agent: Agent,
  context: { node: string; workspace: string; cwd: string },
  run: Runner
): Promise<Check> {
  const launch = () =>
    run(
      ['bun', join(context.workspace, 'agents', agent.wrapper), ...agent.args],
      {
        cwd: context.cwd,
        env: { WS_AGENT_NODE: context.node, PATH: pinnedPath() },
        input: '',
        timeoutMs: 150_000,
      }
    );
  const expected = /\bOK\b/;
  let result = await launch();
  // One retry: a CLI's first launch on a node may still be initializing.
  if (!(result.ok && expected.test(result.stdout))) result = await launch();
  const ok = result.ok && expected.test(result.stdout);
  return {
    id: `agent:${agent.name}:session`,
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `${agent.name} runs signed in through its T3 launcher with the shared account.`
      : sessionFailure(result.stderr + result.stdout),
    ...(ok ? {} : { remedy: { action: sessionRemedy(agent) } }),
  };
}

/** A stable code only; raw CLI output is never reported. */
function sessionFailure(output: string): string {
  if (/missing or out of date/.test(output)) return 'AGENT_PROFILE_STALE';
  if (/Required secret unavailable/.test(output))
    return 'AGENT_VAULT_UNAVAILABLE';
  if (/model_not_found|unknown provider for model/.test(output))
    return 'AGENT_MODEL_UNSERVED';
  return 'AGENT_SESSION_UNVERIFIED';
}

function sessionRemedy(agent: Agent): string {
  if (agent.name === 'antigravity')
    return 'Antigravity sends its own catalog model ids; the proxy serves them through declared aliases that fleet-sync applies on the manager (see proxy:config-pending). Pick Gemini 3.8 Flash in T3: the default Pro model is not served by the shared accounts.';
  return `Run the ${agent.name} launcher on this node to inspect it: WS_AGENT_NODE=<node> bun agents/${agent.wrapper}. Check this node's Vault session and the shared proxy.`;
}

/** The launcher and profile code a session depends on. */
function launcherSources(workspace: string, agent: Agent): string[] {
  const agents = join(workspace, 'agents');
  const lib = join(workspace, 'src/agents');
  return [
    join(agents, agent.wrapper),
    join(agents, 'managed-proxy.ts'),
    ...['launch.ts', 'render.ts', 'secrets.ts', 'toolchain.ts'].map((name) =>
      join(lib, name)
    ),
  ];
}
