Feature: Replacing the manager is described once, in its runbook
  docs/manager-recovery.md is the procedure for a new or lost manager. Every
  other document that talks about replacing the manager links to it instead
  of describing the steps, so the descriptions cannot disagree again. The
  documents are README.md and those under docs/.

  Scenario: Every document that mentions replacing the manager links the runbook
    When the tracked documents that mention replacing the manager are read
    Then there are at least 4 of them
    And every one links to "manager-recovery.md"

  Scenario: Only the runbook shows the restore command
    When the tracked documents are searched for "fleet-restore"
    Then only these documents contain it:
      | docs/manager-recovery.md |
