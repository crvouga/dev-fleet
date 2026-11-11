Feature: The proxy is converged on every sync
  The proxy runs only on the manager; a worker is its client. Each sync asks
  the proxy's own script to bring a machine to its role and reports the phases
  that script names.

  Scenario: Every sync applies; there is no separate maintenance mode
    Given every command prints:
      """
      { "version": 1, "phases": [{ "code": "PROXY_CLIENT_ROLE", "status": "unchanged" }] }
      """
    When the proxy is converged on "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then every command was run with the argument "--apply"
    And no command was run with the argument "--maintenance"

  Scenario: The remedy the proxy names reaches the report, and anything else falls back to the runbook
    A remedy is text written in the proxy's tracked source. A phase that
    carries something else in its place gets the general advice.
    Given every command prints:
      """
      {
        "version": 1,
        "phases": [
          {
            "code": "PROXY_UPDATE_PENDING",
            "status": "action-required",
            "remedy": { "action": "Inspect bun run cliproxy install on the manager." }
          },
          { "code": "PROXY_SOURCE_DRIFT", "status": "action-required", "remedy": 7 }
        ]
      }
      """
    When the proxy is converged on "node" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the checks are, in this order:
      | id                   | status |
      | proxy:update-pending | fail   |
      | proxy:source-drift   | fail   |
    And the remedy of the check "proxy:update-pending" mentions "cliproxy install"
    And the remedy of the check "proxy:source-drift" mentions "audit/recovery runbook"
