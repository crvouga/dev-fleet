Feature: A worker nobody uses is reported idle
  A rented worker is billed by the hour, and the usual waste is one nobody
  has used for days. A worker is idle once its T3 has run no agent turn for
  longer than fleet.json's parking.idleAfterHours: `worker:idle` then warns,
  with how long, and its remedy is to park it. Only what T3 records about its
  turns is read (their status and times), never what a session holds.

  Rule: A worker with an agent turn under way is never idle

    Scenario Outline: A worker whose T3 <runs> and was last active <ago> is <verdict>
      Given a worker whose T3 <runs>, last active at "<last>", up 900000 seconds
      When it is judged at "2026-11-12T12:00:00Z", with workers idle after 12 hours
      Then the check "worker:idle" <outcome>
      And the summary of the check "worker:idle" mentions "<summary>"

      Examples:
        | runs              | ago               | last                 | verdict          | outcome   | summary                                                          |
        | runs 1 agent turn | ten days ago      | 2026-11-02T12:00:00Z | busy, not idle   | passes    | worker-one runs 1 agent turn(s)                                  |
        | runs 0 agent turns | an hour ago      | 2026-11-12T11:00:00Z | not idle         | passes    | the last agent activity was 1h 0m ago                            |
        | runs 0 agent turns | thirty hours ago | 2026-11-11T06:00:00Z | idle             | warns     | has run no agent turn for 1d 6h, longer than the declared 12h    |
        | cannot say what it runs | ten days ago | 2026-11-02T12:00:00Z | not judged     | is skipped | could not be read                                               |

    Scenario: An idle worker's remedy is to park it
      Given a worker whose T3 runs 0 agent turns, last active at "2026-11-10T12:00:00Z", up 900000 seconds
      When it is judged at "2026-11-12T12:00:00Z", with workers idle after 12 hours
      Then the remedy of the check "worker:idle" mentions "devfleet fleet-node-park --id worker-one"

    Scenario: A worker that never ran a turn is idle since it booted
      Given a worker whose T3 runs 0 agent turns, last active at "never", up 172800 seconds
      When it is judged at "2026-11-12T12:00:00Z", with workers idle after 12 hours
      Then the check "worker:idle" warns
      And the summary of the check "worker:idle" mentions "for 2d 0h"

    Scenario: Without a declared time no worker is called idle
      Given a worker whose T3 runs 0 agent turns, last active at "2026-11-01T12:00:00Z", up 900000 seconds
      When it is judged at "2026-11-12T12:00:00Z"
      Then the check "worker:idle" passes
