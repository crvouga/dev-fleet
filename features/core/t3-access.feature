Feature: The manager's access to a worker's T3
  A worker is useful when the manager's own T3 can reach the environment that
  worker runs. Two things are measured, and neither stands in for the other:
  the authenticated link the manager's T3 holds, and a plain HTTPS request to
  the worker's private address.

  Rule: The manager holds a reachable, unexpired link to the very environment the worker runs

    Background:
      Given this worker:
        | id        | dev-one             |
        | ssh       | dev-one             |
        | workspace | /home/dev/workspace |

    Scenario Outline: A link to <whose> environment <outcome>
      The worker says over SSH which environment it runs; a link to any other
      environment proves nothing about this worker.
      Given the time on the manager is "2026-01-01T00:00:00.000Z"
      And the worker reports the T3 environment "expected" over SSH
      And the T3 of the manager lists these links:
        | environment | status    | expires    |
        | <linked>    | reachable | in 30 days |
      When the link from the manager to the T3 of the worker is checked
      Then the check "t3:paired-access" <outcome>

      Examples:
        | whose        | linked   | outcome |
        | the worker's | expected | passes  |
        | another      | other    | fails   |

    Scenario: An environment enrolled in the roster is checked without SSH
      Given the worker is enrolled with the T3 environment "11111111-2222-3333-4444-555555555555"
      And the T3 of the manager lists these links:
        | environment                          | status    | expires    |
        | 11111111-2222-3333-4444-555555555555 | reachable | in 30 days |
      When the link from the manager to the T3 of the worker is checked
      Then the check "t3:paired-access" passes
      And only "t3" commands were run

    Scenario: After a restart in this sync, the check waits for the link to reconnect
      Given the worker is enrolled with the T3 environment "env"
      And the T3 of the worker was restarted in this sync: its link has 60 seconds to reconnect, looked at every 10 seconds
      And the T3 of the manager lists these links:
        | listing | environment | status      | expires    |
        | 1       | env         | unreachable | in 30 days |
        | 2       | env         | unreachable | in 30 days |
        | 3       | env         | reachable   | in 30 days |
      When the link from the manager to the T3 of the worker is checked
      Then the check "t3:paired-access" passes
      And exactly 3 commands were run

  Rule: A request to the private address of a worker is evidence of transport only

    Background:
      Given this worker:
        | id          | fixture |
        | ssh         | fixture |
        | workspace   | /unused |
        | tailscaleId | peer    |
      And Tailscale is running and lists these machines:
        | machine      | ID      | HostName | DNSName                 | OS    | Online | TailscaleIPs |
        | this machine | manager | manager  | manager.fixture.ts.net. | linux | true   | 100.64.0.1   |
        | peer         | peer    | dev      | dev.fixture.ts.net.     | linux | true   | 100.64.0.2   |

    Scenario: An answer from the worker is kept apart from paired access
      Given the address of the worker answers 200 with the body "fixture"
      When the manager requests the T3 endpoint of the worker
      Then the check "t3:manager-endpoint" passes
      And the summary of the check "t3:manager-endpoint" mentions "tool execution remain unverified"
      And every request went to "https://dev.fixture.ts.net" and followed no redirect

    Scenario Outline: The endpoint fails, and nothing it sent is repeated, when <situation>
      Given <answer>
      When the manager requests the T3 endpoint of the worker
      Then the check "t3:manager-endpoint" fails
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | situation                  | answer                                                                       |
        | it redirects               | the address of the worker answers 302 with the body "PRIVATE_SENTINEL"       |
        | the request cannot be made | requests to the address of the worker fail with the error "PRIVATE_SENTINEL" |
