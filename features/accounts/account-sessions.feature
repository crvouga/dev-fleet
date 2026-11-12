Feature: Every per-account instance runs a real session, and account changes re-verify
  T3 offers one instance per proxy account. Each one is verified with a real,
  cheap session through its launcher. A rate-limited account is
  cooling-down, never a pass. An instance whose account the proxy no longer
  holds fails without being run. Results are cached under a key that holds
  the roster version and the client key's version.

  Scenario: Each account the proxy holds gets its own session check
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-sonnet-5-5 |
    And the sessions answer:
      | account       | result       |
      | a@example.com | ok           |
      | b@example.com | cooling-down |
    When the account sessions are checked
    Then the checks are:
      | id                               | status |
      | agent:claude:account-1:session   | pass   |
      | agent:claude:account-2:session   | warn   |
    And no check names "example.com"

  Scenario: Removing an account on the proxy makes that instance's check fail on the next status
    Given this node offers these account instances:
      | tool  | account       |
      | codex | a@example.com |
      | codex | b@example.com |
    And the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the sessions answer:
      | account       | result |
      | a@example.com | ok     |
    When the account sessions are checked
    Then the checks are:
      | id                             | status |
      | agent:codex:account-1:session  | pass   |
      | agent:codex:removed-1:session  | fail   |
    And only the account "a@example.com" was run

  Scenario Outline: What a session's output says about its account: <case>
    When a session that <exit> printed "<output>" is read
    Then its account is "<result>"

    Examples:
      | case                     | exit      | output                                         | result       |
      | it answered              | succeeded | OK                                             | ok           |
      | the relay said it cools  | failed    | This account is cooling down until 2027-01-15  | cooling-down |
      | the provider limited it  | failed    | 429 Too Many Requests                          | cooling-down |
      | anything else            | failed    | model_not_found                                | failed       |

  Scenario: A passing session is not reused once the roster changed
    Given a session check passed under the roster version "aaaa"
    When the session is checked again under the roster version "bbbb"
    Then the session was run again
