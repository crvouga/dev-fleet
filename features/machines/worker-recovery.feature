Feature: A worker's T3 recovery watchdog outlives the revision it came from
  A synced revision is pruned two syncs later. The recovery unit therefore
  runs a copy of its script that the role installs outside every revision,
  never a file inside one.

  Scenario: The recovery unit runs the installed copy
    When the recovery unit the role declares is read
    Then the recovery unit starts "/bin/sh /usr/local/lib/personal-fleet/t3-health.sh"

  Scenario: After its revision is pruned the recovery unit still runs
    Given a revision installed the recovery watchdog as the role declares it
    And that revision has been pruned
    When the recovery unit runs
    Then the recovery unit succeeds
