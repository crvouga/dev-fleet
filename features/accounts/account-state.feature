Feature: Every provider account has a state, and a provider without a usable one fails by name
  Provider accounts exist only as the CLI proxy's credential files. The
  manager derives each account's state from them and from the proxy's
  management API: usable, cooling-down (until when), needs-login,
  refresh-failing or removed. "proxy:account:<provider>" warns when a provider
  is one limit away from none and fails when it has none. A check names an
  account by its opaque index and counts only, never by its sign-in.

  Scenario: Every account of a provider cooling down fails with the time the first one clears
    Given the proxy reports these accounts:
      | provider | index | label         | state        | until                |
      | claude   | 1     | a@example.com | cooling-down | 2027-01-15T09:00:00Z |
      | claude   | 2     | b@example.com | cooling-down | 2027-01-15T08:30:00Z |
      | codex    | 1     | a@example.com | usable       |                      |
      | codex    | 2     | b@example.com | usable       |                      |
    When the account checks are made
    Then the check "proxy:account:claude" fails saying "every one is cooling down; the first clears at 2027-01-15T08:30:00Z"
    And the check "proxy:account:codex" passes
    And no check names "example.com"

  Scenario: A rejected refresh token asks for a new sign-in of exactly that account
    Given the proxy reports these accounts:
      | provider | index | label         | state       | until |
      | codex    | 1     | a@example.com | usable      |       |
      | codex    | 2     | b@example.com | needs-login |       |
    When the account checks are made
    Then the check "proxy:account:codex" warns saying "1 of 2 codex accounts usable (account 2 needs-login)"
    And the check "proxy:account:codex" asks to run "devfleet fleet-accounts --relogin codex 2"
    And no check names "example.com"

  Scenario Outline: The fleet says how many usable accounts are enough
    Given the proxy reports these accounts:
      | provider    | index | label         | state           | until |
      | antigravity | 1     | a@example.com | usable          |       |
      | antigravity | 2     | b@example.com | refresh-failing |       |
      | antigravity | 3     | c@example.com | usable          |       |
    And the fleet wants <minimum> usable accounts of every provider
    When the account checks are made
    Then the check "proxy:account:antigravity" <verdict>

    Examples:
      | minimum | verdict |
      | 1       | passes  |
      | 2       | passes  |
      | 3       | warns   |

  Scenario: A removed account counts for nothing
    Given the proxy reports these accounts:
      | provider | index | label         | state   | until |
      | claude   | 1     | a@example.com | removed |       |
    When the account checks are made
    Then there is no check "proxy:account:claude"
