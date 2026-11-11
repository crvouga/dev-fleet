Feature: A check becomes a diagnostic an operator can act on
  A diagnostic is derived from a check that was already cleaned: its phase, a
  stable code, whose problem it is, and whether trying again could help. It
  never claims more than the check observed.

  In the tables, a value in quotes such as "1234" is text; 1234 is a number.

  Rule: A diagnostic says whose problem it is and whether to try again

    Scenario: A sign-in that is required needs the operator, and is never retried blindly
      Given the check:
        | id      | provider:claude:inference         |
        | status  | fail                              |
        | summary | PROVIDER_AUTH_REQUIRED            |
        | remedy  | Renew existing authorized access. |
      When the diagnostic of that check on "devbox" is made
      Then the diagnostic says:
        | node           | devbox                 |
        | phase          | provider               |
        | code           | PROVIDER_AUTH_REQUIRED |
        | scope          | node                   |
        | retryable      | false                  |
        | actionRequired | true                   |
        | durationMs     | null                   |
      And the remedy of the diagnostic belongs to "dev-fleet"

    Scenario: Stale metrics are the manager's to look at, and can be tried again
      Given the check:
        | id      | beszel:freshness     |
        | status  | fail                 |
        | summary | BESZEL_METRICS_STALE |
      When the diagnostic of that check on "devbox" is made
      Then the diagnostic says:
        | scope     | manager |
        | retryable | true    |

    Scenario: A check nobody ran belongs to no machine, and still needs the operator
      Where a probe ran is not made up when it is not known.
      Given the check:
        | id      | t3:end-to-end                  |
        | status  | skip                           |
        | summary | REQUIRED_ACCEPTANCE_UNVERIFIED |
      When the diagnostic of that check on "devbox" is made
      Then the diagnostic says:
        | scope          | unverified |
        | actionRequired | true       |

  Rule: A check from a worker keeps its measured duration and loses every field the protocol does not have

    Scenario: The duration of a phase survives, and an unknown field does not
      Given the check:
        | id              | ubuntu:baseline  |
        | status          | pass             |
        | summary         | Observed         |
        | phaseDurationMs | 1234             |
        | privateOutput   | PRIVATE_SENTINEL |
      When that check arrives from "fixture" over the protocol
      Then the protocol accepts the check
      And the diagnostic says:
        | durationMs | 1234 |
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario Outline: A phase duration of <duration> is not accepted
      Given the check:
        | id              | ubuntu:baseline  |
        | status          | pass             |
        | summary         | Observed         |
        | phaseDurationMs | <duration>       |
        | privateOutput   | PRIVATE_SENTINEL |
      When that check arrives from "fixture" over the protocol
      Then the protocol does not accept the check

      Examples:
        | duration |
        | -1       |
        | Infinity |
        | "1234"   |
        | 0.5      |
