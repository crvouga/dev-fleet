Feature: A damaged replica is reported as corrupt and restored from an earlier version
  A bucket that answers with a version that cannot be read is not a network
  problem. The copy stands "corrupt", and the remedy restores the version the
  bucket held at an earlier time, which is uploaded again as the current one.

  Background:
    Given managers "a" and "b" replicate to one bucket
    And manager "a" changed the configuration to "good"
    And the time was noted
    And manager "a" changed the configuration to "later"
    And the bucket's latest version was cut short

  Scenario: A truncated replica stands corrupt, not unreachable
    When manager "b" compares its copy with the bucket
    Then it reports "corrupt"

  Scenario: The report sends the operator to an earlier version, not to the network
    When the standing "corrupt" is reported as a check
    Then the check "state:replica" fails
    And its summary contains "cannot be read"
    And its remedy contains "fleet-state --restore --timestamp"

  Scenario: A change on a corrupt replica is kept on the manager and nothing is uploaded over it
    When manager "a" changes the roster to "r"
    Then it reports "corrupt"
    And manager "a" has changes waiting for the bucket

  Scenario: Restoring the earlier version brings the fleet state back to the manager and to the bucket
    Given the operator ran "fleet-state --init --directory $BUCKET" on manager "b"
    When the operator runs "fleet-state --restore --timestamp $NOTED --yes" on manager "b"
    Then the report includes:
      """
      { "standing": "in-sync" }
      """
    And the fleet state of manager "b" holds the configuration "good"
    And manager "a" stands "bucket-ahead" with the bucket

  Scenario: Restoring an earlier version needs --yes
    Given the operator ran "fleet-state --init --directory $BUCKET" on manager "b"
    When the operator runs "fleet-state --restore --timestamp $NOTED" on manager "b"
    Then it is refused with "Repeat with --yes"
