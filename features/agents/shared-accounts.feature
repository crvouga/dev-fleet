Feature: Shared provider accounts
  Accounts are never declared in the repository. The proxy lists a prefixed
  copy of each model for every account signed in on it, and that list is the
  roster an agent can be pinned to.

  Background:
    Given the proxy lists these models:
      | claude-opus-5-5                            |
      | claude-a@example.com/claude-haiku-5-5      |
      | claude-a@example.com/claude-sonnet-5-5     |
      | claude-b@example.com/claude-sonnet-5-5     |
      | codex-a@example.com/gpt-x                  |
      | antigravity-a@example.com/gemini-3.8-flash |
      | antigravity-a@example.com/gemini-3-flash   |
      | devin/claude-opus-5-5                      |
      | xai-a@example.com/grok                     |

  Rule: The roster is exactly the accounts the proxy lists, per tool

    Scenario: Each account is offered through its tool, its preferred models first
      The preferred defaults of a tool come first, then everything else the
      account serves.
      When the roster is read from the model list
      Then the roster is:
        | tool     | email         | prefix                    | models                              |
        | claude   | a@example.com | claude-a@example.com      | claude-sonnet-5-5, claude-haiku-5-5 |
        | claude   | b@example.com | claude-b@example.com      | claude-sonnet-5-5                   |
        | codex    | a@example.com | codex-a@example.com       | gpt-x                               |
        | opencode | a@example.com | antigravity-a@example.com | gemini-3.8-flash, gemini-3-flash    |

    Scenario: A model that no account owns puts nobody on the roster
      Given the proxy lists only the model "claude-opus-5-5"
      When the roster is read from the model list
      Then the roster is empty

  Rule: An unanswered roster is an error; it never reads as no accounts

    Scenario: The roster is asked of the proxy with the machine's own key
      When the roster is asked of the proxy with the key "key"
      Then the roster has 4 accounts

    Scenario Outline: A proxy that answers <status> without its models is not an empty roster
      Given the proxy answers a request for its models with the status <status> and no list
      When the roster is asked of the proxy with the key "key"
      Then it is refused with "The CLI proxy did not list its models."

      Examples:
        | status |
        | 503    |
        | 200    |

  Rule: Only a real account of a routed tool has a prefix

    Scenario: An account's models carry the prefix of its provider
      When the prefix of the "opencode" account "a@example.com" is asked for
      Then the prefix is "antigravity-a@example.com"

    Scenario Outline: <what> has no prefix
      When the prefix of the "<tool>" account "<email>" is asked for
      Then it is refused

      Examples:
        | what                                    | tool   | email           |
        | A tool the proxy routes no accounts for | grok   | a@example.com   |
        | An email that could name another route  | claude | a/b@example.com |

  Rule: Each tool is pinned its own way, and only to a signed-in account

    Scenario: Claude talks to a relay and is told the models a Claude account serves
      Claude sends whichever model was picked, so it talks to a loopback
      relay that adds the account's prefix.
      Given a relay that listens at "http://127.0.0.1:9"
      When "claude" is launched on the machine "node" for the account "a@example.com", with its profile in "/tmp/x/claude/proxy"
      Then its environment sets "ANTHROPIC_BASE_URL" to "http://127.0.0.1:9"
      And its environment sets "ANTHROPIC_DEFAULT_HAIKU_MODEL" to "claude-haiku-5-5"

    Scenario: OpenCode needs no relay: it is offered exactly the account's models
      Given the environment sets "OPENCODE_CONFIG" to "/shared.json"
      When "opencode" is launched on the machine "node" for the account "a@example.com", with its profile in "/tmp/x/opencode/proxy"
      Then its environment no longer sets "OPENCODE_CONFIG"
      And its OpenCode configuration enables only the provider "personal_proxy"
      And its OpenCode configuration offers exactly these models from "personal_proxy":
        | antigravity-a@example.com/gemini-3.8-flash |
        | antigravity-a@example.com/gemini-3-flash   |

    Scenario: An account that is not signed in on the proxy is refused
      When "codex" is launched on the machine "node" for the account "b@example.com", with its profile in "/tmp/x/codex/proxy"
      Then it is refused with "not signed in"
