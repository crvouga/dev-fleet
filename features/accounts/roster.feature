Feature: One provider account roster, the same on every node
  The proxy's credential files are the only roster. Its version is a digest
  of the routing prefixes of the accounts every node offers: the manager
  computes it from the credential files, and every node from the proxy's
  model list, so the two agree exactly when the node offers what the proxy
  holds. Nothing on a node holds a provider login of its own.

  Scenario: The roster version is the same digest the manager computes
    The manager's digest of the same two accounts is asserted in
    cliproxy/tests/test_accounts.py.
    Given the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-opus-5-5   |
    When the roster version is computed from the model list
    Then the roster version is "ff95b2561c9dab07"

  Scenario: Adding an account on the proxy changes the roster version
    Given the proxy lists these models:
      | codex-a@example.com/gpt-6.1-sol |
    And the roster version is computed from the model list
    And the proxy now also lists "codex-b@example.com/gpt-6.1-sol"
    When the roster version is computed from the model list
    Then the roster version has changed

  Scenario: A node that does not offer a new account is behind
    Given this node offers these account instances:
      | tool   | account       |
      | claude | a@example.com |
    And the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | claude-b@example.com/claude-sonnet-5-5 |
    When this node's roster is checked
    Then the check "accounts:roster-current" fails
    And it asks to run "devfleet fleet-sync --only accounts"
    And no check names "example.com"

  Scenario: A node that offers every account of the proxy is current
    Given this node offers these account instances:
      | tool   | account       |
      | claude | a@example.com |
      | codex  | a@example.com |
    And the proxy lists these models:
      | claude-a@example.com/claude-sonnet-5-5 |
      | codex-a@example.com/gpt-6.1-sol        |
    When this node's roster is checked
    Then the check "accounts:roster-current" passes

  Scenario: A provider login made by hand on a worker is reported, by CLI only
    Given a home where these files exist:
      | .codex/auth.json          |
      | .claude/.credentials.json |
    When the node is checked for provider logins of its own
    Then the check "accounts:native-login" warns saying "Provider logins outside the proxy path: claude, codex."
    And no check names ".codex/auth.json"

  Scenario: A node with no login of its own passes
    Given a home where these files exist:
      | .codex/config.toml |
    When the node is checked for provider logins of its own
    Then the check "accounts:native-login" passes
