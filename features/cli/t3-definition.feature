Feature: The T3 providers a machine gets
  The package ships a definition of the fixed provider instances. Every
  account signed in on the CLI proxy adds one more, pinned to that account.
  A definition never holds a credential, and no account is named in source.

  Rule: The fixed instances are filled in for the machine, and nothing else is accepted

    Scenario: Paths and the name of the machine are substituted as they are written
      Given the T3 definition the package ships
      And no account is signed in on the CLI proxy
      When the providers are worked out for the machine "test-node" with dev-fleet at '/repo/with "quotes"'
      Then exactly these providers are declared:
        | personal_gateway_models |
        | personal_grok_proxy     |
      And what is declared contains "test-node"

    Scenario Outline: A definition with "<field>" set to <value> is refused
      A definition may not rename a fixed variable into a credential, give
      one a real key, or name a driver the fleet does not manage.
      Given the T3 definition the package ships, edited to set "<field>" to <value>
      And no account is signed in on the CLI proxy
      When the providers are worked out for the machine "node" with dev-fleet at "/repo"
      Then it is refused with "Invalid"

      Examples:
        | field                                             | value      |
        | instances.personal_grok_proxy.environment.0.name  | "API_KEY"  |
        | instances.personal_grok_proxy.environment.1.value | "xai-real" |
        | instances.personal_grok_proxy.driver              | "pi"       |

  Rule: Every account signed in on the CLI proxy becomes a provider pinned to it

    Scenario: Each account gets an instance that names it and holds no credential
      In what is declared below, "…text…" stands for any text that contains it.
      Given the T3 definition the package ships
      And these accounts are signed in on the CLI proxy:
        | tool     | email         | prefix                    | models |
        | claude   | a@example.com | claude-a@example.com      | m      |
        | opencode | a@example.com | antigravity-a@example.com | g      |
      When the providers are worked out for the machine "node" with dev-fleet at "/repo"
      Then the provider "personal_claude_a_example_com" is declared exactly as:
        """
        {
          "driver": "claudeAgent",
          "displayName": "Claude a@example.com",
          "enabled": true,
          "config": {
            "binaryPath": "/repo/agents/claude-proxy",
            "homePath": "…/node/claude/account-a_example_com…"
          },
          "environment": [
            { "name": "WS_AGENT_NODE", "value": "node", "sensitive": false },
            {
              "name": "WS_AGENT_ACCOUNT",
              "value": "a@example.com",
              "sensitive": false
            }
          ]
        }
        """
      And the provider "personal_antigravity_a_example_com" is declared with at least:
        """
        { "driver": "opencode", "displayName": "AntiGravity a@example.com" }
        """

    Scenario: No account is ever named in tracked source
      Then the T3 definition the package ships does not contain "@"

    Scenario: A proxy that does not answer fails the whole definition
      Providers are never dropped because the accounts could not be read.
      Given the T3 definition the package ships
      And the CLI proxy does not answer: "proxy down"
      When the providers are worked out for the machine "node" with dev-fleet at "/repo"
      Then it is refused with "proxy down"
