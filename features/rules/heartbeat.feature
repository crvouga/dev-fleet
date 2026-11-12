Feature: Something off the manager notices when the manager stops watching
  Every watcher runs on the manager, so a manager that is off, asleep or
  offline notices nothing. Each fleet-watch run stores a heartbeat in the
  bucket; a reusable workflow, called from the repository that holds the
  fleet's fleet.json, fails when that heartbeat is too old.

  Scenario: A consumer calls the workflow with its bucket and two secrets
    Then the heartbeat workflow can be called with the inputs:
      | bucket          |
      | endpoint        |
      | region          |
      | prefix          |
      | max-age-minutes |
    And the heartbeat workflow needs the secrets:
      | DEVFLEET_BUCKET_ACCESS_KEY_ID     |
      | DEVFLEET_BUCKET_SECRET_ACCESS_KEY |

  Scenario: A recent heartbeat passes and names the workers that were degraded
    Given the bucket holds a heartbeat from 10 minutes ago, with "worker-a" degraded
    When the heartbeat workflow runs with a limit of 60 minutes
    Then the heartbeat check passes
    And the heartbeat check says "Degraded when the manager last looked: worker-a"

  Scenario: A manager that stopped watching fails the check
    Given the bucket holds a heartbeat from 90 minutes ago, with "" degraded
    When the heartbeat workflow runs with a limit of 60 minutes
    Then the heartbeat check fails
    And the heartbeat check says "FLEET_HEARTBEAT_STALE"

  Scenario: A bucket with no heartbeat fails the check
    Given the bucket holds no heartbeat
    When the heartbeat workflow runs with a limit of 60 minutes
    Then the heartbeat check fails
    And the heartbeat check says "FLEET_HEARTBEAT_MISSING"
