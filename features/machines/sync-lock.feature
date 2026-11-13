Feature: One sync at a time on the manager
  A sync takes the lock "sync.lock" in the manager's private state directory
  and records the process that owns it. While a sync is really running,
  another is refused. A lock whose owner is provably gone is reclaimed, so an
  interrupted run needs no cleanup by hand; anything uncertain stays locked.

  Background:
    Given an empty manager state directory

  Scenario: A second sync is refused while one is running
    Given a sync is running
    When another sync starts
    Then it is refused with "locked"

  Scenario: A sync that finished has released the lock
    Given a sync ran to its end
    When another sync starts
    Then it runs

  Scenario: A lock left by a process that no longer exists is reclaimed, with the transfer bundle it left
    Process 4194305 is 2^22 + 1, above the process numbers of Linux and macOS,
    so it is never alive. A killed run never removes its transfer bundle;
    holding the lock means none is in use.
    Given a lock whose owner is recorded as:
      """
      {"version":1,"pid":4194305,"startedAt":"x"}
      """
    And a file "transfer-aaaaaaaa-0000.bundle" in the directory
    When another sync starts
    Then it runs
    And "transfer-aaaaaaaa-0000.bundle" is gone from the directory
    And "sync.lock" is gone from the directory

  Scenario: A lock owned by a process that is alive is never stolen
    Given a lock whose owner is recorded as the process running these scenarios
    When another sync starts
    Then it is refused with "locked"
    And "sync.lock" is still in the directory

  Scenario: A lock that names no owner is held while it is fresh
    A run that has just taken the lock has not recorded itself yet.
    Given a lock that records no owner
    When another sync starts
    Then it is refused with "locked"

  Scenario: A lock that names no owner is reclaimed once it has been abandoned
    Given a lock that records no owner
    And the lock was last changed 120 seconds ago
    When another sync starts
    Then it runs

  Scenario: Two syncs that find the same abandoned lock never both run
    A killed run left the lock. Two syncs start together and both judge it
    abandoned; the first reclaims it and is running before the second moves
    the lock aside. The second finds the lock it moved is held, puts it back
    and is refused.
    Given a lock whose owner is recorded as:
      """
      {"version":1,"pid":4194305,"startedAt":"x"}
      """
    And a sync that has judged the lock abandoned but not yet reclaimed it
    And another sync has reclaimed the lock and is running
    When the first sync goes on
    Then it is refused with "locked"
    And the running sync still holds "sync.lock"

  Scenario: A sync releases only the lock it took
    Given a sync is running
    And its lock has been replaced by one whose owner is recorded as the process running these scenarios
    When the running sync ends
    Then "sync.lock" is still in the directory
