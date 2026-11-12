Feature: A replacement manager is checked, then restored from the bucket
  `fleet-restore --dry-run` verifies every prerequisite of a manager restore
  on a clean machine and lists what would be restored, changing nothing.
  docs/manager-recovery.md is the runbook. Manager "a" is the old manager;
  manager "b" is a clean Mac that has only the documented inputs: the
  project's fleet.json, the bucket and its credentials, its local host name,
  Git, Tailscale and Docker.

  Background:
    Given managers "a" and "b" replicate to one bucket
    And manager "a" changed the configuration to "from a"
    And "~/project/fleet.json" on manager "b" holds the example fleet with the bucket:
      """
      { "directory": "$BUCKET" }
      """
    And commands on manager "b" are passed:
      | DEVFLEET_CONFIG | ~/project/fleet.json |
    And manager "b" is a clean Mac named "manager-mac" with Git, Tailscale and Docker

  Scenario: The dry run passes on a clean Mac with only the documented inputs
    When the operator runs "fleet-restore --dry-run" on manager "b"
    Then the command exits 0
    And the report lists exactly these checks:
      | restore:configuration    | pass |
      | restore:bucket           | pass |
      | restore:state            | pass |
      | restore:host-name        | pass |
      | restore:git              | pass |
      | restore:tailscale        | pass |
      | restore:container-engine | pass |
    And the report contains "T3 ownership record"
    And the fleet state of manager "b" holds no configuration

  Scenario: A machine with another local host name fails the dry run with the command that names it
    Given manager "b" is a clean Mac named "some-laptop" with Git, Tailscale and Docker
    When the operator runs "fleet-restore --dry-run" on manager "b"
    Then the command exits 1
    And the report includes these checks:
      | restore:host-name | fail |
    And the report contains "scutil --set LocalHostName manager-mac"

  Scenario: A bucket that holds no fleet state fails the dry run
    Given the bucket was emptied
    When the operator runs "fleet-restore --dry-run" on manager "b"
    Then the report includes these checks:
      | restore:state | fail |

  Scenario: The restore takes the fleet state from the bucket
    When the operator runs "fleet-restore" on manager "b"
    Then the command exits 0
    And the fleet state of manager "b" holds the configuration "from a"
