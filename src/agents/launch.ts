import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AgentConfigurationError } from './errors';
import { registry, type Selection } from './registry';
import { accountPrefix, accountSlug, discoverAccounts } from './accounts';
import { startAccountRelay } from './account-relay';
import { proxyKey } from './secrets';
import { pinnedBinary, pinnedPath } from './toolchain';

/** `account` (its email) pins a proxy launch to one signed-in proxy account. */
export async function launchProfile(
  root: string,
  selection: Selection,
  args: string[],
  account?: string
): Promise<number> {
  const directory = join(
    root,
    selection.node,
    selection.tool,
    selection.profile
  );
  const env = { ...process.env };
  env['PATH'] = pinnedPath(env);
  // Do not allow an ambient gateway to silently change the selected route.
  for (const name of [
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLIPROXY_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'GROK_MODELS_BASE_URL',
    'GROK_CODE_XAI_API_KEY',
    'XAI_API_KEY',
  ])
    delete env[name];
  if (selection.profile === 'proxy') {
    env['CLIPROXY_API_KEY'] = await proxyKey();
    configureGatewayEnvironment(env, selection);
  }
  toolEnvironment(env, selection, directory);
  const pinned =
    account && selection.profile === 'proxy'
      ? await pinAccount(env, selection, { account, directory })
      : null;
  try {
    return await spawnAgent(selection, directory, env, [
      pinned?.args ?? [],
      args,
    ]);
  } finally {
    pinned?.stop();
  }
}

async function spawnAgent(
  selection: Selection,
  directory: string,
  env: NodeJS.ProcessEnv,
  [pinned, args]: [string[], string[]]
): Promise<number> {
  // Resolve the executable before launchArgs may point HOME at the profile.
  const executable =
    selection.tool === 'antigravity' && args[0] !== 'acp'
      ? pinnedBinary(selection.tool, env)
      : selection.tool;
  const command = [
    executable,
    ...pinned,
    ...launchArgs(selection, directory, args, env),
  ];
  if (selection.tool === 'antigravity' && args[0] === 'acp')
    return relayAcp(command, env);
  const child = Bun.spawn(command, {
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

/** Routes every request of this launch to one account's proxy credential.
 * Claude and Codex send whichever model was picked, so they talk to a loopback
 * relay that adds the account's model prefix. OpenCode lists exactly the
 * account's prefixed models, so it needs no relay.
 */
export async function pinAccount(
  env: NodeJS.ProcessEnv,
  selection: Selection,
  { account, directory }: { account: string; directory: string },
  { relay = startAccountRelay, discover = discoverAccounts } = {}
): Promise<{ args: string[]; stop: () => void }> {
  const prefix = accountPrefix(selection.tool, account);
  // What the account serves right now, preferred default first.
  const served = (await discover(env['CLIPROXY_API_KEY'] ?? '')).find(
    (entry) => entry.tool === selection.tool && entry.email === account
  );
  if (!served)
    throw new AgentConfigurationError(
      'This account is not signed in on the CLI proxy.'
    );
  if (selection.tool === 'opencode') {
    delete env['OPENCODE_CONFIG'];
    env['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(accountOpenCode(served));
    return { args: [], stop: () => {} };
  }
  const { url, stop } = relay(registry.proxy.endpoint, prefix);
  if (selection.tool === 'claude') {
    env['ANTHROPIC_BASE_URL'] = url;
    // Aliases and the default must name models a Claude account serves.
    const [opus, sonnet, haiku] = (
      registry.proxy.accounts as Record<string, { models: string[] }>
    )['claude']!.models;
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = opus;
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = sonnet;
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = haiku;
    env['ANTHROPIC_MODEL'] = sonnet;
    return { args: [], stop };
  }
  // Each account keeps its own Codex sessions; the provider is declared on
  // the command line because that home has no rendered config.
  env['CODEX_HOME'] = join(directory, '..', `account-${accountSlug(account)}`);
  mkdirSync(env['CODEX_HOME'], { recursive: true, mode: 0o700 });
  const provider = {
    name: 'Personal CLI Proxy',
    base_url: `${url}/v1`,
    env_key: 'CLIPROXY_API_KEY',
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
  };
  return {
    args: [
      ['model', served.models[0]],
      ['model_provider', 'personal_proxy'],
      ...Object.entries(provider).map(
        ([key, value]) =>
          [`model_providers.personal_proxy.${key}`, value] as const
      ),
    ].flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    stop,
  };
}

/** OpenCode configuration that offers only one account's models. */
function accountOpenCode(route: { prefix: string; models: string[] }) {
  const models = route.models.map((model) => `${route.prefix}/${model}`);
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `personal_proxy/${models[0]}`,
    enabled_providers: ['personal_proxy'],
    provider: {
      personal_proxy: {
        npm: '@ai-sdk/openai',
        options: {
          baseURL: registry.proxy.endpoint + '/v1',
          apiKey: '{env:CLIPROXY_API_KEY}',
        },
        models: Object.fromEntries(
          models.map((id) => [id, { name: id.slice(route.prefix.length + 1) }])
        ),
      },
    },
  };
}

/** Per-tool profile selection and self-updater switches. */
function toolEnvironment(
  env: NodeJS.ProcessEnv,
  selection: Selection,
  directory: string
): void {
  if (selection.tool === 'claude') env['DISABLE_AUTOUPDATER'] = '1';
  if (selection.tool === 'codex') env['CODEX_HOME'] = directory;
  if (selection.tool === 'opencode')
    env['OPENCODE_CONFIG'] = join(directory, 'opencode.json');
  if (selection.tool === 'gemini') env['GEMINI_CLI_HOME'] = directory;
  if (selection.tool === 'grok') {
    env['GROK_HOME'] = directory;
    env['GROK_DISABLE_AUTOUPDATER'] = '1';
  }
  // Only "true" disables Antigravity's in-place self-updater ("1" is ignored).
  if (selection.tool === 'antigravity')
    env['AGY_CLI_DISABLE_AUTO_UPDATE'] = 'true';
}

/** T3's managed policy may not carry a credential, so its Antigravity
 * instance keeps the default Google sign-in method. The proxy key is the
 * credential here: the one ACP `authenticate` request is switched to the
 * Gemini API-key method on its way in; every other message passes unchanged.
 */
async function relayAcp(
  command: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const child = Bun.spawn(command, {
    env,
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  void (async () => {
    let pending = '';
    for await (const chunk of process.stdin) {
      pending += String(chunk);
      let end = pending.indexOf('\n');
      while (end >= 0) {
        void child.stdin.write(
          rewriteAuthenticate(pending.slice(0, end)) + '\n'
        );
        pending = pending.slice(end + 1);
        end = pending.indexOf('\n');
      }
      void child.stdin.flush();
    }
    if (pending) void child.stdin.write(rewriteAuthenticate(pending));
    void child.stdin.end();
  })();
  return child.exited;
}

const BROWSER_SIGN_IN = new Set(['oauth-personal', 'oauth-business']);

/** Rewrites only an ACP `authenticate` request for a browser sign-in method. */
export function rewriteAuthenticate(line: string): string {
  if (!line.includes('"authenticate"')) return line;
  try {
    const message = JSON.parse(line) as {
      method?: unknown;
      params?: { methodId?: unknown };
    };
    if (
      message.method !== 'authenticate' ||
      !BROWSER_SIGN_IN.has(String(message.params?.methodId))
    )
      return line;
    return JSON.stringify({
      ...message,
      params: { ...message.params, methodId: 'gemini-api-key' },
    });
  } catch {
    return line;
  }
}

/** Tool-specific arguments that select the rendered profile. */
export function launchArgs(
  selection: Selection,
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv
): string[] {
  if (selection.tool === 'claude')
    return ['--settings', join(directory, 'settings.json'), ...args];
  if (selection.tool === 'antigravity') {
    // Over ACP (how T3 runs it) T3 owns a private GEMINI_HOME and selects the
    // Gemini API key method; the proxy key and endpoint come from this wrapper.
    // Run directly, the fleet profile is the home; one-shot print mode only
    // reads ~/.gemini, so it also runs with HOME set to the profile.
    if (args[0] === 'acp') {
      env['GEMINI_HOME'] ??= join(directory, '.gemini');
      return ['acp', '--disable-telemetry', ...args.slice(1)];
    }
    env['HOME'] = directory;
  }
  return args;
}

function configureGatewayEnvironment(
  env: NodeJS.ProcessEnv,
  selection: Selection
): void {
  if (selection.tool === 'gemini' || selection.tool === 'antigravity') {
    delete env['GOOGLE_GENAI_USE_VERTEXAI'];
    delete env['GOOGLE_GENAI_USE_GCA'];
    env['GOOGLE_GEMINI_BASE_URL'] = registry.proxy.endpoint;
    env['GEMINI_API_KEY'] = env['CLIPROXY_API_KEY'];
  }
  if (selection.tool === 'claude') {
    delete env['ANTHROPIC_API_KEY'];
    env['ANTHROPIC_BASE_URL'] = registry.proxy.endpoint;
    env['ANTHROPIC_AUTH_TOKEN'] = env['CLIPROXY_API_KEY'];
    for (const family of ['OPUS', 'SONNET', 'HAIKU'])
      env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = selection.model;
  }
}
