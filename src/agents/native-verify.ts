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
    // T3's binaryPath: the Claude Agent SDK runs a `.ts` path with node.
    launcher: 'claude-proxy',
    args: ['-p', PROMPT],
  },
  {
    name: 'codex',
    binary: 'codex',
    pin: 'codex',
    wrapper: 'codex-proxy.ts',
    launcher: 'codex-proxy.ts',
    args: ['exec', '--skip-git-repo-check', PROMPT],
  },
  {
    name: 'grok',
    binary: 'grok',
    pin: 'http:grok',
    wrapper: 'grok-proxy.ts',
    launcher: 'grok-proxy.ts',
    args: ['-p', PROMPT],
  },
  {
    name: 'antigravity',
    binary: 'antigravity',
    pin: 'http:antigravity',
    wrapper: 'antigravity-proxy.ts',
    launcher: 'antigravity-proxy.ts',
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
    launcher: 'opencode-proxy.ts',
    args: ['run', '--model', 'personal_proxy/devin/muse-wonder-1-0', PROMPT],
  },
] as const;

type Agent = (typeof NATIVE_AGENTS)[number];

/** The user service T3 runs as on a worker, and so the environment every
 * agent it starts inherits.
 */
export const T3_SERVICE = 't3code-desktop.service';

/** How a session is launched: by the sync, through Bun on the pinned PATH,
 * or exactly as the T3 service starts it, with that service's environment
 * and nothing of the sync's.
 */
type Launch =
  | { kind: 'sync' }
  | { kind: 'service'; env: Record<string, string> }
  | { kind: 'incomplete' };

/** Same versions everywhere (from the shared mise.lock) and a working signed-in
 * session through each T3 launcher. Agents run concurrently and are bounded.
 * With `t3Service` (a Linux worker), sessions run in the environment of the
 * T3 user service, where T3 itself starts them, not in the sync's.
 */
export async function verifyNativeAgents(
  node: string,
  workspace: string,
  run: Runner,
  options: {
    /** Proxy routes already found out of quota; their sessions are not run. */
    outOfQuota?: Set<string>;
    cache?: VerifyCache;
    t3Service?: boolean;
  } = {}
): Promise<Check[]> {
  const { outOfQuota = new Set<string>(), cache = {} } = options;
  const pins = parsePins(await readFile(join(workspace, 'mise.toml'), 'utf8'));
  const environment = options.t3Service
    ? await serviceLaunch(run)
    : { launch: { kind: 'sync' } as Launch, checks: [] };
  const { launch } = environment;
  const cwd = await mkdtemp(join(tmpdir(), 'fleet-agents-'));
  try {
    const results = await Promise.all(
      NATIVE_AGENTS.map(async (agent) => [
        await versionCheck(agent, pins[agent.pin], run),
        outOfQuota.has(agent.name)
          ? quotaPass(agent)
          : launch.kind === 'incomplete'
            ? incompleteSession(agent)
            : await cachedCheck(
                `agent-${node}-${agent.name}`,
                cacheKey(
                  node,
                  agent,
                  pins[agent.pin] ?? '',
                  registry,
                  await sourceKey(launcherSources(workspace, agent))
                ),
                () =>
                  sessionCheck(agent, { node, workspace, cwd, launch }, run),
                cache
              ),
      ])
    );
    return [...environment.checks, ...results.flat()];
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
  context: { node: string; workspace: string; cwd: string; launch: Launch },
  run: Runner
): Promise<Check> {
  const agents = join(context.workspace, 'agents');
  const command =
    context.launch.kind === 'service'
      ? [join(agents, agent.launcher), ...agent.args]
      : ['bun', join(agents, agent.wrapper), ...agent.args];
  const env =
    context.launch.kind === 'service'
      ? { ...context.launch.env, WS_AGENT_NODE: context.node }
      : { WS_AGENT_NODE: context.node, PATH: pinnedPath() };
  const launch = () =>
    run(command, {
      cwd: context.cwd,
      env,
      ...(context.launch.kind === 'service' ? { isolatedEnv: true } : {}),
      input: '',
      timeoutMs: 150_000,
    });
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

/** The environment of the T3 user service: what its user manager holds
 * (PATH included) and what the unit adds. Every launcher starts with
 * `#!/usr/bin/env bun` or runs `bun`, so that PATH must find Bun.
 */
async function serviceLaunch(
  run: Runner
): Promise<{ launch: Launch; checks: Check[] }> {
  const manager = await run(['systemctl', '--user', 'show-environment'], {
    timeoutMs: 15_000,
  });
  const unit = await run(
    [
      'systemctl',
      '--user',
      'show',
      T3_SERVICE,
      '--property=Environment',
      '--value',
    ],
    { timeoutMs: 15_000 }
  );
  if (!manager.ok || !unit.ok)
    return {
      launch: { kind: 'sync' },
      checks: [
        environmentCheck(
          'warn',
          'AGENT_SERVICE_ENVIRONMENT_UNVERIFIED',
          'The environment of the T3 service could not be read, so sessions were launched from the sync instead. Inspect the user service manager of this worker: systemctl --user show-environment.'
        ),
      ],
    };
  const env = {
    ...parseAssignments(manager.stdout.split('\n')),
    ...parseAssignments(words(unit.stdout)),
  };
  const bun = await run(['/bin/sh', '-c', 'command -v bun'], {
    env,
    isolatedEnv: true,
    timeoutMs: 15_000,
  });
  if (!bun.ok)
    return {
      launch: { kind: 'incomplete' },
      checks: [
        environmentCheck(
          'fail',
          'AGENT_SERVICE_ENVIRONMENT_INCOMPLETE',
          INCOMPLETE_REMEDY
        ),
      ],
    };
  return {
    launch: { kind: 'service', env },
    checks: [
      environmentCheck(
        'pass',
        'The T3 service environment finds Bun; every session was launched with it alone.'
      ),
    ],
  };
}

const INCOMPLETE_REMEDY = `The PATH of ${T3_SERVICE} does not find Bun, so T3 cannot start any agent launcher even though they work from a shell. Put the pinned shims on the PATH of the user service manager through the baseline (never by hand), then run fleet-sync.`;

function environmentCheck(
  status: Check['status'],
  summary: string,
  remedy?: string
): Check {
  return {
    id: 'agent:service-environment',
    status,
    summary,
    ...(remedy ? { remedy: { action: remedy } } : {}),
  };
}

function incompleteSession(agent: Agent): Check {
  return {
    id: `agent:${agent.name}:session`,
    status: 'fail',
    summary: 'AGENT_SERVICE_ENVIRONMENT_INCOMPLETE',
    remedy: { action: INCOMPLETE_REMEDY },
  };
}

/** `KEY=value` lines or words; a value systemd quoted loses its quotes. */
function parseAssignments(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry.trim());
    if (match) env[match[1]!] = unquote(match[2]!);
  }
  return env;
}

/** `systemctl show -p Environment` separates assignments with spaces and
 * double-quotes one that holds a space.
 */
function words(line: string): string[] {
  return line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function unquote(value: string): string {
  return value.replace(/"([^"]*)"/g, '$1').replace(/^\$'(.*)'$/s, '$1');
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
