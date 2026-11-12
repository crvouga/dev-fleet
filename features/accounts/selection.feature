Feature: Which account serves a request is declared, deterministic and cooldown-aware
  The fleet declares per provider how an unpinned request picks its account:
  fill-first in a stated order, round-robin, or least-recently-limited. The
  order is the accounts the policy names, in its order, then the others in
  the order of their routing prefix. An account cooling down is skipped.

  Scenario Outline: The order of <strategy> is deterministic
    Given the accounts "codex-c@example.com, codex-a@example.com, codex-b@example.com"
    And the policy "<strategy>" naming first "<named>"
    When <requests> requests choose their accounts
    Then the last request tries "<order>"

    Examples:
      | strategy    | named         | requests | order                                                       |
      | fill-first  |               | 1        | codex-a@example.com, codex-b@example.com, codex-c@example.com |
      | fill-first  | c@example.com | 1        | codex-c@example.com, codex-a@example.com, codex-b@example.com |
      | fill-first  | c@example.com | 3        | codex-c@example.com, codex-a@example.com, codex-b@example.com |
      | round-robin |               | 2        | codex-b@example.com, codex-c@example.com, codex-a@example.com |

  Scenario: An unpinned request whose first account is out of quota succeeds on the second
    Given the accounts "codex-a@example.com, codex-b@example.com"
    And the policy "fill-first" naming first ""
    And the proxy answers 429 for "codex-a@example.com" and 200 for every other account
    When an unpinned agent posts {"model":"gpt-6.1-sol"}
    Then the agent receives the status 200
    And the proxy was sent the models "codex-a@example.com/gpt-6.1-sol, codex-b@example.com/gpt-6.1-sol"
    And the next request tries only "codex-b@example.com"

  Scenario: An account that is cooling down is skipped
    Given the accounts "codex-a@example.com, codex-b@example.com"
    And the policy "fill-first" naming first ""
    And the proxy answers 429 for "codex-a@example.com" and 200 for every other account
    And an unpinned agent has posted {"model":"m"}
    When an unpinned agent posts {"model":"m"}
    Then the proxy was sent the models "codex-a@example.com/m, codex-b@example.com/m, codex-b@example.com/m"

  Scenario: A pinned account that is cooling down says until when, and names the alternatives
    Given the proxy answers 429 for "claude-a@example.com" and 200 for every other account
    When an agent pinned to "claude-a@example.com" with the alternative "b@example.com" posts {"model":"m"} twice
    Then both answers have the status 429 and say "This account is cooling down until"
    And both answers say "Pick another instance of this provider in T3: b@example.com."
    And the proxy was asked once
