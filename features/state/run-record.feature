Feature: A fleet-sync run records its approval and its result in the fleet state
  Before any machine changes, the run records the revision it was approved
  for. Once its result is known it records what it applied and what that
  replaced, then uploads what it changed. Its report carries the check
  "state:replica", which says whether the bucket holds the record.

  Background:
    Given commands on the manager are passed:
      | DEVFLEET_STATE | ~/state |
    And the manager replicates to the bucket

  Scenario: A run that fails leaves its approval, and the bucket still receives it
    Given a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is approved
    When the run ends without converging
    Then its report carries the check "state:replica" as "pass"
    And the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """

  Scenario: A run that converges records what it applied and what it replaced, even while the bucket is away
    The bucket going away never fails the run: it is reported as a warning.
    Given a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ended without converging
    And a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" converged
    And a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is approved
    And the bucket stops answering
    When the run converges
    Then its report carries the check "state:replica" as "warn"
    And the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "previousRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """

  Scenario: Workers that converged keep their progress when the fleet is not ready
    One offline worker must not throw away what the others applied.
    Given a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is approved
    When the run ends without converging, with these workers converged:
      | worker-two | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
    Then the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workers": { "worker-two": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      }
      """

  Scenario: What was recorded while the run ran is kept when it ends
    A run retires a worker whose record was removed, and records that. Its
    result is written over what the fleet state holds then, not over what it
    held when the run started: the retired worker does not come back.
    Given the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "appliedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workers": { "worker-one": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "worker-two": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      }
      """
    And a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is approved
    And the manager stored the enrollment:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workers": { "worker-two": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        "retired": { "worker-one": "2026-01-01T00:00:00.000Z" }
      }
      """
    When the run ends without converging, with these workers converged:
      | worker-two | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
    Then the enrollment of the manager is exactly:
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "appliedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workers": { "worker-two": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        "retired": { "worker-one": "2026-01-01T00:00:00.000Z" }
      }
      """

  Rule: What a run could not upload, the next run uploads

    Background:
      Given a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ended without converging
      And a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" converged
      And a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" was approved
      And the bucket stopped answering
      And the run converged
      And the bucket answered again

    Scenario: The next run starts ahead of the bucket and uploads both changes
      Given a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is approved
      When the run converges
      Then the run had started "local-ahead"
      And its report carries the check "state:replica" as "pass"

    Scenario: Repeating a converged run changes nothing and uploads nothing
      Given a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" converged
      And a fleet-sync run for revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is approved
      When the run converges
      Then its report carries the check "state:replica" as "pass"
      And Litestream was not started after the run began

  Rule: A run that stops before its report still uploads its approval

    Scenario: The approval is in the bucket for a replacement manager to find
      Manager "b" is the replacement.
      Given manager "b" replicates to the bucket
      And a fleet-sync run for revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is approved
      When the run stops before its report
      Then the run had started "empty"
      And a refresh of the manager reports "in-sync"
      And a refresh of manager "b" reports "in-sync"
      And the enrollment in the fleet state of manager "b" contains "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
