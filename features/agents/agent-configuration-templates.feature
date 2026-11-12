@ansible @slow
Feature: The agents play writes each CLI's configuration from templates, byte for byte
  The configuration files of every agent CLI already exist on running
  machines, so every byte of them is an interface. The agents play
  (ansible/agents/agents.yml) renders them from its templates, and dev-fleet
  says beforehand what each must hold. The play records a receipt only for
  files that hold exactly that, so a template that drifted from what every
  machine has fails the apply instead of rewriting the fleet.

  These scenarios run the play with the Ansible the manager runs, against a
  directory of their own and the example fleet configuration, whose proxy is
  https://cli-proxy.example.com.

  Rule: Every profile is written exactly as dev-fleet specifies it

    Scenario Outline: The <profile> profile of <tool> is written exactly as specified
      Given the "<profile>" profile of "<tool>" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the profile is applied
      Then every file of the profile holds, byte for byte, what dev-fleet specifies for it
      And the profile holds exactly the files dev-fleet specifies, and its receipt
      And its receipt records the SHA-256 digest of every file as written
      And its receipt is, byte for byte, the one dev-fleet records for it
      And a preview reports "<file>" as "unchanged"

      Examples:
        | tool        | profile | file                                  |
        | codex       | direct  | config.toml                           |
        | codex       | proxy   | config.toml                           |
        | claude      | direct  | settings.json                         |
        | claude      | proxy   | settings.json                         |
        | grok        | direct  | config.toml                           |
        | grok        | proxy   | config.toml                           |
        | antigravity | direct  | .gemini/antigravity-cli/settings.json |
        | antigravity | proxy   | .gemini/antigravity-cli/settings.json |
        | gemini      | direct  | .gemini/settings.json                 |
        | gemini      | proxy   | .gemini/settings.json                 |
        | opencode    | direct  | opencode.json                         |
        | opencode    | proxy   | opencode.json                         |

    Scenario: Codex through the proxy, as every machine has it
      Given the "proxy" profile of "codex" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the profile is applied
      Then its "config.toml" is, byte for byte:
        """
        model = "gpt-6.1-sol"
        model_provider = "personal_proxy"
        [model_providers.personal_proxy]
        name = "Personal CLI Proxy"
        base_url = "https://cli-proxy.example.com/v1"
        env_key = "CLIPROXY_API_KEY"
        wire_api = "responses"
        requires_openai_auth = false
        supports_websockets = false
        """

    Scenario: Grok through the proxy, as every machine has it
      Given the "proxy" profile of "grok" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the profile is applied
      Then its "config.toml" is, byte for byte:
        """
        [cli]
        auto_update = false

        [marketplace]
        default_skills_installs_purged = true

        [models]
        default = "personal-proxy"

        [model.personal-proxy]
        model = "grok-4.7"
        name = "grok-4.7 (Personal CLI Proxy)"
        base_url = "https://cli-proxy.example.com/v1"
        env_key = "CLIPROXY_API_KEY"
        api_backend = "chat_completions"
        """

    Scenario: Gemini through the proxy, as every machine has it
      Given the "proxy" profile of "gemini" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the profile is applied
      Then its ".gemini/settings.json" is, byte for byte:
        """
        {
          "model": {
            "name": "gemini-3-flash"
          },
          "security": {
            "auth": {
              "selectedType": "gateway"
            }
          }
        }
        """

  Rule: The play is safe to repeat and to dry-run, and vouches only for what it wrote

    Scenario: Running the play again on a profile it wrote changes nothing
      Given the "proxy" profile of "opencode" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      And the profile has been applied
      When the agents play runs again with the same variables
      Then the play succeeded
      And the play reported no change

    Scenario: A dry run of the play writes nothing
      Given the "proxy" profile of "antigravity" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the agents play is run in check mode for the profile
      Then the play succeeded
      And the agent directory is still empty

    Scenario: A rendered file that is not what dev-fleet specifies never replaces the one in place
      A template that drifted from the specification fails the apply: the
      play compares each rendered file with the digest dev-fleet gave it
      before the file is moved into place. Here the digest is what differs.
      Given the "proxy" profile of "claude" for the machine "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", in an empty agent directory
      When the agents play is told "settings.json" must have the digest "0000000000000000000000000000000000000000000000000000000000000000"
      Then the play failed with "AGENT_PROFILE_RENDER_MISMATCH"
      And the profile holds no file
