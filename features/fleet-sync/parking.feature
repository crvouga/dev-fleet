Feature: A worker that is off on purpose is parked, not failed
  A rented machine costs money while it runs, so it is stopped overnight or
  destroyed while nobody needs it. devfleet fleet-node-park records that in
  the fleet state: the worker is then listed as parked, with the time since,
  and fleet-sync and fleet-status neither contact it nor fail because of it.
  devfleet fleet-node-resume brings it back and syncs it. fleet.json may
  declare the commands that stop and start a machine (an infrastructure
  tool); dev-fleet calls them with the worker ID and never a provider itself.

  Background:
    Given the manager has enrolled "worker-one" and "worker-two" from the example fleet, bound to the devices "old-one" and "old-two"
    And the fleet state records that revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" was applied
    And fleet.json declares the stop command "infra/machine stop" and the start command "infra/machine start"

  Rule: Parking never ends an agent turn by surprise

    Scenario: A worker that runs no agent turn is parked, and the stop command runs with its ID
      Given the T3 of "worker-one" runs no agent turn
      When the operator parks "worker-one"
      Then the command exits with 0
      And the fleet state records "worker-one" as parked at "2026-11-01T00:01:00.000Z"
      And the declared commands ran:
        | infra/machine stop worker-one |

    Scenario: A worker that runs an agent turn is not parked
      Given the T3 of "worker-one" runs 2 agent turns
      When the operator parks "worker-one"
      Then the command exits with 1
      And the report mentions "WORKER_BUSY"
      And the fleet state records "worker-one" as active
      And no declared command ran

    Scenario: A worker whose T3 cannot say what it runs is not parked either
      Given the T3 of "worker-one" cannot say what it runs
      When the operator parks "worker-one"
      Then the command exits with 1
      And the report mentions "WORKER_ACTIVITY_UNREADABLE"

    Scenario: --force parks it anyway
      Given the T3 of "worker-one" runs 1 agent turn
      When the operator parks "worker-one" with --force
      Then the command exits with 0
      And the fleet state records "worker-one" as parked at "2026-11-01T00:01:00.000Z"

    Scenario: A worker that does not answer is off already, and is parked
      Given the T3 of "worker-one" does not answer
      When the operator parks "worker-one"
      Then the command exits with 0
      And the fleet state records "worker-one" as parked at "2026-11-01T00:01:00.000Z"

    Scenario: A stop command that fails leaves the worker active
      Given the T3 of "worker-one" runs no agent turn
      And the stop command fails
      When the operator parks "worker-one"
      Then the command exits with 1
      And the report mentions "WORKER_STOP_HOOK_FAILED"
      And the fleet state records "worker-one" as active

  Rule: Resuming starts the machine and syncs that worker

    Background:
      Given the operator has parked "worker-one"

    Scenario: Resume runs the start command, marks the worker active and syncs it
      When the operator resumes "worker-one"
      Then the command exits with 0
      And the declared commands ran:
        | infra/machine start worker-one |
      And the fleet state records "worker-one" as active
      And fleet-sync ran for "worker-one" only

    Scenario: A resume whose sync does not end ready fails
      Given the fleet-sync after a resume does not end ready
      When the operator resumes "worker-one"
      Then the command exits with 1
      And the report mentions "WORKER_RESUME_FAILED"
