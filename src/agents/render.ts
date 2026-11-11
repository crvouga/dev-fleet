import { join, win32 } from 'node:path';
import type { PlatformName } from '../platform/types';
import { registry, type Selection } from './registry';

/** Dedicated outputs; native login/state directories are never copied. */
export function agentRoot(home: string, platform: PlatformName): string {
  return platform === 'windows'
    ? win32.join(home, 'AppData', 'Local', 'personal', 'agents')
    : join(home, '.config', 'personal', 'agents');
}

export function render(s: Selection): Record<string, string> {
  const model = JSON.stringify(s.model);
  if (s.tool === 'codex') {
    const provider =
      s.profile === 'proxy'
        ? '\nmodel_provider = "personal_proxy"\n[model_providers.personal_proxy]\nname = "Personal CLI Proxy"\nbase_url = ' +
          JSON.stringify(registry.proxy.endpoint + '/v1') +
          '\nenv_key = "CLIPROXY_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'
        : '\n';
    return { 'config.toml': `model = ${model}${provider}` };
  }
  if (s.tool === 'claude')
    return {
      'settings.json': JSON.stringify({ model: s.model }, null, 2) + '\n',
    };
  if (s.tool === 'grok') return { 'config.toml': grokConfig(s) };
  if (s.tool === 'antigravity')
    return {
      // The fleet profile home for direct and one-shot runs (see launchArgs);
      // never the human's ~/.gemini. T3 keeps its own private GEMINI_HOME.
      '.gemini/antigravity-cli/settings.json':
        JSON.stringify({ modelProvider: 'gemini' }, null, 2) + '\n',
    };
  if (s.tool === 'gemini')
    return {
      '.gemini/settings.json':
        JSON.stringify(
          {
            model: { name: s.model },
            ...(s.profile === 'proxy'
              ? { security: { auth: { selectedType: 'gateway' } } }
              : {}),
          },
          null,
          2
        ) + '\n',
    };
  const config =
    s.profile === 'proxy'
      ? {
          $schema: 'https://opencode.ai/config.json',
          model: `personal_proxy/${s.model}`,
          provider: {
            personal_proxy: {
              npm: '@ai-sdk/openai',
              options: {
                baseURL: registry.proxy.endpoint + '/v1',
                apiKey: '{env:CLIPROXY_API_KEY}',
              },
              models: Object.fromEntries(
                [
                  ...Object.values(registry.proxy.routes).map(
                    (route) => route.model
                  ),
                  s.model,
                ].map((id) => [id, { name: id }])
              ),
            },
          },
        }
      : { $schema: 'https://opencode.ai/config.json', model: s.model };
  return { 'opencode.json': JSON.stringify(config, null, 2) + '\n' };
}

/** Grok Build reads custom models only from GROK_HOME/config.toml. The key
 * comes from the environment (env_key), never the file; no grok login.
 */
function grokConfig(s: Selection): string {
  // Grok records a one-time skills migration in config.toml; declaring it up
  // front keeps the rendered file unchanged by the CLI (no profile drift).
  const lines = [
    '[cli]',
    'auto_update = false',
    '',
    '[marketplace]',
    'default_skills_installs_purged = true',
    '',
  ];
  if (s.profile !== 'proxy')
    return [
      ...lines,
      '[models]',
      `default = ${JSON.stringify(s.model)}`,
      '',
    ].join('\n');
  return [
    ...lines,
    '[models]',
    'default = "personal-proxy"',
    '',
    '[model.personal-proxy]',
    `model = ${JSON.stringify(s.model)}`,
    `name = ${JSON.stringify(`${s.model} (Personal CLI Proxy)`)}`,
    `base_url = ${JSON.stringify(registry.proxy.endpoint + '/v1')}`,
    'env_key = "CLIPROXY_API_KEY"',
    'api_backend = "chat_completions"',
    '',
  ].join('\n');
}
