Feature: fleet-sync brings the manager's fleet state up to the bucket before it changes anything, and uploads what it records
  A run records the revision it was approved for in the fleet state. With a
  bucket, it first takes the bucket's version when its own copy is stale,
  refuses to run on a copy that diverged, and uploads its record even when it
  stops early.

  The manager here has no worker enrolled and nothing installed but a
  stand-in for Litestream, so every run stops at
  FLEET_MANAGER_ENROLLMENT_REQUIRED, after it has used the state and before
  it reaches a machine. Manager "b" is another manager of the same fleet, or
  its replacement.
  `$BUCKET` is the directory that stands in for the bucket.

  Background:
    Given fleet-sync runs on a manager with no worker enrolled

  Scenario: Without a bucket a run still records its approval in the local state
    When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the command exits 1
    And the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And Litestream was never started
    And the run started over 0 times

  Scenario: A run uploads its approval even when it stops before its report
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the manager stands "in-sync" with the bucket
    And a refresh of manager "b" reports "in-sync"
    And the enrollment in the fleet state of manager "b" contains "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: A stale manager takes the bucket's state and starts over before it changes anything
    The run builds on what the other manager applied instead of erasing it.
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the run started over 1 time
    And the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    And the manager stands "in-sync" with the bucket

  Scenario: A manager whose state diverged from the bucket changes nothing
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And fleet-sync ran for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And manager "b" refreshed its copy
    And the bucket stopped answering
    And fleet-sync ran for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    And the bucket answered again
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc"
      }
      """
    When fleet-sync runs for revision "dddddddddddddddddddddddddddddddddddddddd"
    Then the command exits 1
    And the report contains "FLEET_STATE_DIVERGED"
    And the report contains "fleet-state --restore --yes"
    And the enrollment in the fleet state of the manager is what it was before the run
    And the manager stands "diverged" with the bucket

  Scenario: A preview records no approval
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the command exits 1
    And the manager has no enrollment

  Scenario: A preview of a stale manager is made from the bucket's state, and uploads nothing
    A preview made from a stale copy would plan against a fleet that no
    longer exists. Bringing the copy up to the bucket never uploads.
    Given the manager saved the bucket "$BUCKET" in its bucket.json
    And manager "b" replicates to the bucket
    And manager "b" stored the enrollment and uploaded it:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When fleet-sync previews revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the run started over 1 time
    And the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    And the manager stands "in-sync" with the bucket
    And the report contains "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: A run from a project replicates to the bucket its fleet.json names and records the configuration it applied
    Nothing is saved on the manager: it has no bucket.json. A replacement
    manager, or a run started outside the project (the schedule, a hand-off
    from a worker), finds what was applied.
    Given "~/fleet.json" on the manager holds the example fleet with the bucket:
      """
      { "directory": "$BUCKET" }
      """
    And the process runs with the fleet.json "~/fleet.json"
    And manager "b" replicates to the bucket
    When fleet-sync runs for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then Litestream was started
    And a refresh of manager "b" reports "in-sync"
    And the fleet state of manager "b" holds the configuration that "~/fleet.json" on the manager declares
    And the enrollment in the fleet state of manager "b" contains "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: --rollback approves the revision applied before the current one
    A rollback applies the playbooks and pins of the previous revision: the
    revision, the tools and T3 go back; system packages roll forward only.
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """
    When fleet-sync rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: --rollback after a failed upgrade approves the revision still applied
    The canary failed on the approved revision, so the applied one is the
    revision before it: the rollback goes back to that one, not to the one
    applied before it.
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """
    When fleet-sync rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: --rollback after a failed first upgrade approves the revision still applied
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "cccccccccccccccccccccccccccccccccccccccc",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When fleet-sync rolls back
    Then the report contains "FLEET_MANAGER_ENROLLMENT_REQUIRED"
    And the approved revision of the manager is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: --rollback with no earlier revision changes nothing
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    When fleet-sync rolls back
    Then the command exits 1
    And the report contains "FLEET_ROLLBACK_UNAVAILABLE"
    And the enrollment in the fleet state of the manager is what it was before the run
