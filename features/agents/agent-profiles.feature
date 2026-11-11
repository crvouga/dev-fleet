Feature: Agent profiles
  Every agent on every machine runs from a profile dev-fleet renders and
  owns: a direct one, or one routed through the proxy. A profile names where a
  credential is found, never the credential, and is kept apart from the
  agent's own sign-in and state.

  Rule: An audit exposes the names of settings, never credentials or values

    Scenario: The audit of an agent's settings lists their names only
      Given an agent has these settings:
        """
        {
          "model": "PRIVATE_SENTINEL",
          "apiKey": "PRIVATE_SENTINEL",
          "mcpServers": { "token": "PRIVATE_SENTINEL" }
        }
        """
      When the settings are audited
      Then the audit names exactly:
        | apiKey     |
        | mcpServers |
        | model      |
      And the audit does not contain "PRIVATE_SENTINEL"

  Rule: Routes and platform destinations are separate, and carry no secret value

    Scenario: Codex through the proxy names the variable that holds the key
      When the "proxy" profile of "codex" is rendered for the machine "canary"
      Then its "config.toml" contains:
        | wire_api = "responses"       |
        | env_key = "CLIPROXY_API_KEY" |

    Scenario: Codex used directly never names the proxy
      When the "direct" profile of "codex" is rendered for the machine "canary"
      Then its "config.toml" does not contain "personal_proxy"

    Scenario: Gemini through the proxy is sent to the gateway
      When the "proxy" profile of "gemini" is rendered for the machine "node"
      Then its ".gemini/settings.json" contains:
        | gateway |

    Scenario: OpenCode through the proxy is the harness for the other routes
      When the "proxy" profile of "opencode" is rendered for the machine "node"
      Then its "opencode.json" contains:
        | grok-4.7              |
        | devin/muse-wonder-1-0 |

    Scenario Outline: On <platform>, profiles are kept under <directory>
      When agent profiles are located for the home "<home>" on "<platform>"
      Then they are kept under "<directory>"

      Examples:
        | platform | home         | directory                                  |
        | windows  | C:\Users\dev | C:\Users\dev\AppData\Local\personal\agents |
        | linux    | /home/dev    | /home/dev/.config/personal/agents          |

  Rule: An agent runs only a model the registry approves

    Scenario Outline: Through the proxy, <tool> runs <model>
      When "<tool>" is selected with the "proxy" profile on the machine "node"
      Then its model is "<model>"

      Examples:
        | tool   | model             |
        | gemini | gemini-3-flash    |
        | claude | claude-sonnet-4-6 |

    Scenario: A model reviewed for one machine replaces the default there
      Given the registry approves the model "reviewed-model" for "codex" with the "direct" profile on the machine "canary"
      When the model of "codex" with the "direct" profile on the machine "canary" is resolved
      Then its model is "reviewed-model"

    Scenario: A machine ID that could name another directory is refused
      When "codex" is selected with the "direct" profile on the machine "../escape"
      Then it is refused

  Rule: A preview is read-only; applying is repeatable and detects modifications

    Background:
      Given the "proxy" profile of "codex" for the machine "canary" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory

    Scenario: A preview says what would be written and writes nothing
      When the profile is previewed
      Then the preview reports "config.toml" as "create"
      And the agent directory is still empty

    Scenario: Applying a profile again changes nothing
      Given the profile has been applied
      When the profile is applied again
      Then its receipt is as the first apply wrote it
      And a preview reports "config.toml" as "unchanged"
      And its receipt records the SHA-256 digest of "config.toml" as rendered

    Scenario: A managed file someone edited is refused, and what it holds is not reported
      Given the profile has been applied
      And "config.toml" has since been overwritten with "PRIVATE_SENTINEL"
      When the profile is applied again
      Then it is refused with "Unmanaged"
      And the public plan does not contain "PRIVATE_SENTINEL"

    Scenario: Adopting a profile replaces the file someone edited
      Given the profile has been applied
      And "config.toml" has since been overwritten with "PRIVATE_SENTINEL"
      When the profile is applied again, adopting what is there
      Then a preview reports "config.toml" as "unchanged"

    Scenario: Two applies never run at once
      Given another apply holds ".apply-lock" in the agent directory
      When the profile is applied
      Then it is refused with "Another apply"

    Scenario: A destination reached through a symlink is refused
      Given "alias" in the agent directory is a symlink to the agent directory
      When the destination "alias/config" is checked
      Then it is refused with "Symlink conflict"
