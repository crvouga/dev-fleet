Feature: Native agents are verified on every machine
  Every agent T3 offers runs at the version the shared toolchain pins, and
  through the launcher T3 uses, signed in with the shared account. A check
  reports a stable code; what a command printed is never reported.

  Rule: Every native agent is pinned in the shared toolchain

    Scenario: mise.toml pins every agent T3 offers
      When the pins of mise.toml are read
      Then every agent T3 offers is pinned:
        | agent       | pin                     |
        | claude      | claude                  |
        | codex       | codex                   |
        | grok        | http:grok               |
        | antigravity | http:antigravity        |
        | muse        | aqua:anomalyco/opencode |
      And "http:grok" is pinned to "1.0.77"
      And "claude" is pinned to a release number

  Rule: A machine's agents match the lock and run signed in

    Background:
      Given nothing verified earlier is remembered

    Scenario: Matching versions and signed-in launchers pass
      Given every agent reports the version mise.toml pins
      And every launcher answers "OK"
      When the agents of the machine "node-a" are verified
      Then there are 10 checks: a version check and a session check for each agent
      And every check passes
      And exactly these launchers were run:
        | claude-proxy.ts      |
        | codex-proxy.ts       |
        | grok-proxy.ts        |
        | antigravity-proxy.ts |
        | opencode-proxy.ts    |

    Scenario: A version drift or a missing Vault session fails with a stable code only
      Given every agent reports the version "0.0.0"
      And every launcher answers "OK"
      But the "grok-proxy.ts" launcher fails with:
        """
        Required secret unavailable: secret/data/personal/prd CLIPROXY_FLEET_CLIENT_API_KEY. raw-detail
        """
      And the "antigravity-proxy.ts" launcher fails with:
        """
        unknown provider for model gemini-3.8-flash
        """
      When the agents of the machine "node-a" are verified
      Then the check "agent:grok:version" reports "AGENT_VERSION_MISMATCH"
      And the remedy of the check "agent:grok:version" mentions "mise install"
      And the check "agent:grok:session" reports "AGENT_VAULT_UNAVAILABLE"
      And the check "agent:antigravity:session" reports "AGENT_MODEL_UNSERVED"
      And the remedy of the check "agent:antigravity:session" mentions "proxy:config-pending"
      And the check "agent:claude:session" passes
      And no check contains "raw-detail"

    Scenario: A drifted binary is reinstalled from the lock, then passes
      A vendor's self-updater rewrote the binary; the locked artifact is
      installed over it and the version is checked again.
      Given every agent reports the version mise.toml pins
      But "antigravity" reports the version "9.9.9" until it is reinstalled
      And every launcher answers "OK"
      When the agents of the machine "node-a" are verified
      Then every check passes
      And the only reinstall was of "http:antigravity", at the version mise.toml pins

    Scenario: An account out of quota passes quietly without launching its session
      Quota is the account's, not the machine's.
      Given every agent reports the version mise.toml pins
      And every launcher answers "OK"
      And the shared "codex" account is out of quota
      When the agents of the machine "node-a" are verified
      Then every check passes
      And the "codex-proxy.ts" launcher was not run

    Scenario: A first-launch failure is retried once
      An agent's first launch on a machine may still be initializing.
      Given every agent reports the version mise.toml pins
      And every launcher answers "OK"
      But the "grok-proxy.ts" launcher fails the first time it is run and then answers "OK"
      When the agents of the machine "node-a" are verified
      Then the check "agent:grok:session" passes
      And the "grok-proxy.ts" launcher was run 2 times

  Rule: A remembered session is proven again once the agent's configuration changes

    A session is remembered under a key made of its pin, the launchers, the
    proxy account roster, the client key and the agent's profile as it is
    on the machine. A profile rendered again, edited or removed proves
    nothing about the session that passed with the old one.

    Background:
      Given verified sessions are remembered
      And the agent profiles of the machine "node-a" are rendered
      And every agent reports the version mise.toml pins
      And every launcher answers "OK"
      And the agents of the machine "node-a" have been verified once

    Scenario: Nothing changed, so no session is launched again
      When the agents of the machine "node-a" are verified
      Then no launcher was run again
      And every check passes

    Scenario Outline: The <agent> profile changed, so only its session is launched again
      Given the "<tool>" profile of the machine "node-a" now holds something else
      When the agents of the machine "node-a" are verified
      Then only the launcher "<launcher>" was run again
      And every check passes

      Examples:
        | agent  | tool     | launcher          |
        | codex  | codex    | codex-proxy.ts    |
        | muse   | opencode | opencode-proxy.ts |

  Rule: On a worker, a session runs in the environment T3 starts it in

    The sync runs over SSH with the pinned tools on its PATH; T3 runs as a
    user service with only what its service manager gives it. A launcher
    that works from the sync proves nothing about T3 unless it is started
    the same way.

    Background:
      Given nothing verified earlier is remembered
      And every agent reports the version mise.toml pins
      And every launcher answers "OK"

    Scenario: Launchers run with the service's environment alone, as T3 runs them
      Given the agents run where T3 runs them, on a worker whose user service manager holds:
        | PATH | /home/dev/.local/share/mise/shims:/usr/bin:/bin |
        | HOME | /home/dev                                       |
      And the T3 service adds "T3CODE_HOME=/home/dev/.t3 TMPDIR=/var/tmp"
      And Bun is found on that PATH
      When the agents of the machine "node-a" are verified
      Then every check passes
      And the check "agent:service-environment" passes
      And every launcher ran with exactly this environment:
        | PATH          | /home/dev/.local/share/mise/shims:/usr/bin:/bin |
        | HOME          | /home/dev                                       |
        | T3CODE_HOME   | /home/dev/.t3                                   |
        | TMPDIR        | /var/tmp                                        |
        | WS_AGENT_NODE | node-a                                          |
      And every launcher was run directly, as T3 runs it, never through "bun"
      And exactly these launchers were run:
        | claude-proxy         |
        | codex-proxy.ts       |
        | grok-proxy.ts        |
        | antigravity-proxy.ts |
        | opencode-proxy.ts    |

    Scenario: A service whose PATH cannot find Bun fails every session without launching one
      Every launcher starts with Bun, so T3 could start none of them.
      Given the agents run where T3 runs them, on a worker whose user service manager holds:
        | PATH | /usr/bin:/bin |
      And the T3 service adds "T3CODE_HOME=/home/dev/.t3"
      And Bun is not found on that PATH
      When the agents of the machine "node-a" are verified
      Then the check "agent:service-environment" reports "AGENT_SERVICE_ENVIRONMENT_INCOMPLETE"
      And every session check reports "AGENT_SERVICE_ENVIRONMENT_INCOMPLETE"
      And no launcher was run

    Scenario: A service environment that cannot be read is reported, and sessions run from the sync
      Given the agents run where T3 runs them, on a worker whose service manager cannot be read
      When the agents of the machine "node-a" are verified
      Then the check "agent:service-environment" warns
      And the check "agent:service-environment" reports "AGENT_SERVICE_ENVIRONMENT_UNVERIFIED"
      And the check "agent:claude:session" passes
