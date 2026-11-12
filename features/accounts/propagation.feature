Feature: Account changes reach every node without a full sync
  "fleet-sync --only accounts" applies only the account-derived
  configuration: on the manager and on every worker at once, each node
  re-reads the proxy's roster and rewrites its per-account T3 instances. T3
  watches its settings, so nothing restarts and no running turn ends.

  Background:
    Given the enrolled workers "worker-one" and "worker-two" at the approved revision

  Scenario: Every worker is asked for the accounts and nothing else
    Given every worker applies its accounts
    When the accounts are propagated
    Then it exits with 0
    And each worker was sent exactly one request, for the action "accounts"
    And the manager applied its own accounts

  Scenario: An unreachable worker is reported and the others still change
    It catches up on the next propagation and reports the roster version it
    has until then.
    Given every worker applies its accounts
    And "worker-two" cannot be reached
    When the accounts are propagated
    Then it exits with 1
    And "worker-one" reports the check "t3:providers" passing
    And "worker-two" reports a failed SSH check
