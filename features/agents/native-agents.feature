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
