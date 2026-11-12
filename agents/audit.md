# Agent configuration audit and ownership

Audited against the checked-in tool pins and client source, installed T3 source
`322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`, and linked vendor documentation.
This is a compatibility inventory, not a claim that all desktop apps or fleet
nodes were inspected or authenticated. The execution host exposes Codex, Claude
and T3 on PATH; the mise catalog additionally includes Gemini, Copilot and OpenCode.
Cursor and Antigravity are desktop prerequisites, not mise-managed binaries.

| Source/owner                                                                                   | Installed destination                                                   | Scope                                                                                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `mise.toml`, `mise.lock`, `.mise/locks/`; bootstrap                                            | Global mise config, shims and installed tools                           | Versions; no authentication                                                                      |
| `agents/registry.json`; dev-fleet                                                              | Dedicated profile outputs described below                               | Endpoint, models, secret references, node model overrides                                        |
| `ansible/agents/templates/` (specified by `src/agents/render.ts`); `ansible/agents/agents.yml` | `ROOT/NODE/codex/{direct,proxy}/config.toml`                            | Separate CODEX_HOME, Responses HTTP/SSE provider declaration                                     |
| same                                                                                           | `ROOT/NODE/claude/{direct,proxy}/settings.json`                         | Passed using native --settings; process environment routes proxy                                 |
| same                                                                                           | `ROOT/NODE/opencode/{direct,proxy}/opencode.json`                       | OPENCODE_CONFIG, environment key placeholder                                                     |
| same                                                                                           | `ROOT/NODE/gemini/direct/.gemini/settings.json`                         | GEMINI_CLI_HOME is the profile root; independent native login                                    |
| `src/agents/converge.ts` decides, `ansible/agents/agents.yml` writes                           | Each profile's receipt.json; ROOT/backups                               | Nonsecret fingerprints/revision; private migration backups                                       |
| Existing `opencode/provider-secrets.ts`, OpenRouter package; dev-fleet                         | Platform OpenCode directory/opencode.json                               | Vault provider catalog, OpenRouter auto policy; existing sync embeds private keys with mode 0600 |
| Existing OpenCode plugins/bin and cli/lib/links.ts; dev-fleet                                  | Platform OpenCode plugins/bin, tui.json, notifier files                 | Notification plugins, sounds, platform-derived app paths                                         |
| `agents/codex-proxy.ts`; dev-fleet                                                             | T3 binaryPath points directly into reviewed Git checkout                | Runtime Vault injection; WS_AGENT_NODE is a declared machine value                               |
| `agents/t3.json`; personal T3 reconciler                                                       | T3CODE_HOME/userdata/settings.json                                      | Owned provider instances only; plan/apply/import/cleanup and private ownership state             |
| `../fleet/definition.json`, cli/lib/net; dev-fleet                                             | Managed SSH block and VS Code Remote-SSH settings                       | Existing machine aliases, OS/user/identity public paths and T3 ports; no private keys            |
| `.agents/commands/*.md`; agents:sync                                                           | Harness command symlinks                                                | Canonical agent commands; do not edit copies                                                     |
| Root AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md                          | Repository instruction discovery                                        | Same canonical repository rules                                                                  |
| Existing cliproxy clients/bootstrap.py and launcher.py                                         | ~/.config/cliproxy-fleet; ~/.local/bin/*-fleet                          | Legacy opt-in migration boundary; native settings preserved                                      |
| Fleet configure                                                                                | checkout/node_modules/.fleet-revisions/SHA; .fleet-configuration/*.json | Pinned Git deployment worktrees and per-selection rollout receipts                               |

ROOT is `~/.config/personal/agents` on macOS/Linux and
`%USERPROFILE%\AppData\Local\personal\agents` on native Windows. Home and platform
are documented machine-derived inputs. The explicit `--node` ID selects checked-in
`nodes[ID][TOOL].direct` or `.proxy` model overrides over shared defaults. The local
fleet roster contains connection aliases/paths, not configuration values or secrets.

The registry is the portable profile source. Native project settings, organization
policies, MCP servers, skills and plugins can still affect tools through their
vendor precedence. These are not silently imported from a home directory. Existing
home MCP definitions, user skills, marketplace caches and desktop settings remain
unmanaged until reviewed and added to an appropriate canonical repository source.
Do not treat the registry as a complete export of arbitrary installed applications.
Usage tracking in CLIProxyAPI/T3 is independent from the inference route.

## Compatibility and authentication evidence

- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference):
  CODEX_HOME, model_providers, env_key and wire_api. Direct profiles have separate
  login state. T3 source confirms homePath and binaryPath per provider instance.
- [Claude gateway](https://code.claude.com/docs/en/llm-gateway-connect) and
  [settings](https://code.claude.com/docs/en/settings): native settings-file override
  plus ANTHROPIC_BASE_URL/AUTH_TOKEN. The registry declares `claude-sonnet-4-6`; availability and authentication are checked separately.
- [OpenCode](https://opencode.ai/docs/config/): OPENCODE_CONFIG merges with native
  configuration; environment placeholders avoid persisting the proxy key. Direct
  OpenRouter defaults remain owned by the existing provider sync.
- [Gemini CLI](https://geminicli.com/docs/reference/configuration/): native settings,
  GEMINI_CLI_HOME and Google/API-key/Vertex authentication are distinct. Pinned 0.66.0 also supports `gateway` authentication, `GOOGLE_GEMINI_BASE_URL` and a runtime `GEMINI_API_KEY`; the managed proxy adapter uses those native interfaces. Live native-client acceptance remains unverified.
- [Cursor](https://prod.cursor.com/help/models-and-usage/api-keys): supported API-key
  setup uses Settings > Models; some features continue through Cursor. No supported
  unattended portable credential/settings adapter was established; no SQLite edits.
- [Antigravity](https://antigravity.google/docs/settings): native Google identity and
  settings are distinct from Gemini CLI. No verified arbitrary proxy-routing adapter.
- [Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli): native independent
  GitHub authentication. No proxy integration is claimed.

Runtime OAuth, auth.json, keychains, T3 pairing/control-plane tokens, SSH private
keys, session databases, conversations, histories, caches and plugin downloaded
state are never profile source. Never export or copy them between nodes. Backups
may preserve preexisting local contents and therefore stay private, outside Git.
New proxy profiles read only Vault `secret/data/personal/prd` field
`CLIPROXY_FLEET_CLIENT_API_KEY`; neither generated configs nor receipts contain it.
Missing access fails without retaining Vault responses. No secret is seeded here.

## Fleet provider routes

The registry’s `proxy.routes` declares the shared accounts (Claude, Codex,
Gemini, Grok, Muse, Antigravity). Grok Build and the Antigravity CLI are pinned
native clients with proxy profiles (Grok: `GROK_HOME/config.toml` custom model
with `env_key`; Antigravity: Gemini API-key mode with `GOOGLE_GEMINI_BASE_URL`).
Muse runs through the OpenCode harness: native Muse Code only talks to Meta's
own catalog endpoint. Cursor is not managed (it cannot use the proxy). T3's
Antigravity instance uses T3's own runtime with the proxy key in T3's per-host
secret store. See the fleet guide's "Agents on every node".
Version-specific source evidence:
[Gemini 0.66.0 gateway interface](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/core/contentGenerator.ts),
[CLIProxyAPI 8.0.55 catalog](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.55/internal/registry/models/models.json).
A catalog entry is only a supported identifier, not proof that Chris has an
active account for it. Fleet verifies authenticated availability, inference,
stream completion and a harmless echo-tool round trip. Native application/T3
acceptance is recorded separately. Runtime Vault access must work without an
interactive shell; missing renewal authorization remains action required.
