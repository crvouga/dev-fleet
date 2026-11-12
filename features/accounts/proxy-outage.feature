Feature: A proxy outage is retried by every launcher and then named
  Every launch of an agent that reaches the proxy through an address its
  wrapper sets goes through a loopback relay, pinned or not, so every one
  rides out a proxy restart the same way and, when the proxy stays down,
  receives one distinct, retryable error.

  Scenario: A proxy that never answers yields "proxy unreachable since"
    Given the proxy never answers
    When an unpinned agent posts {"model":"m"}
    Then the agent receives the status 503
    And the answer says "The CLI proxy has been unreachable since 2027-01-15T08:00:00.000Z"
    And the relay waited for 1, 2, 4, 8, 15, 30 seconds in turn

  Scenario Outline: An unpinned <tool> launch is sent through a relay
    When an unpinned "<tool>" launch is prepared with a relay at "http://127.0.0.1:4000"
    Then <how>

    Examples:
      | tool        | how                                                                                      |
      | claude      | its environment sets "ANTHROPIC_BASE_URL" to "http://127.0.0.1:4000"                     |
      | antigravity | its environment sets "GOOGLE_GEMINI_BASE_URL" to "http://127.0.0.1:4000"                 |
      | codex       | it is given the arguments "-c model_providers.personal_proxy.base_url=\"http://127.0.0.1:4000/v1\"" |
      | grok        | no relay is started                                                                      |

  Scenario Outline: Each node measures that it reaches the proxy: <case>
    Given the proxy answers with the status <status> after <latency> ms
    When this node checks that it reaches the proxy
    Then the check "proxy:reachable-from" <verdict>

    Examples:
      | case                    | status | latency | verdict |
      | it answers fast         | 401    | 40      | passes  |
      | it answers slowly       | 401    | 2500    | warns   |
      | only the route answers  | 530    | 40      | fails   |
