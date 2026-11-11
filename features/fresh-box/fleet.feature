@fresh-box @slow
Feature: One fleet-sync over several fresh machines, and the faults it meets
  The production bootstrap runs over real SSH connections against disposable
  Ubuntu machines, each with only an SSH server and an account that can use
  sudo. Faults are made on the machines themselves: a held lock, a dropped
  connection, a killed installer, a broken resolver, a full disk. Only the
  tailnet is a stand-in, because the machines are not on one.

  A container has no systemd, so some checks a real worker passes fail here.
  That makes every run here a partial verification: it must say so, and must
  not record the revision as applied.

  Background:
    Given these fresh Ubuntu 26.04 machines, each with only an SSH server and an account that can use sudo:
      | fleet-a |
      | fleet-b |
    And the tailnet shows each of them online under its own name

  Scenario: One run bootstraps every machine and reports each of them in one versioned result
    When fleet-sync applies the commit under test to every machine in one run
    Then the report is version 3 and covers, in order:
      | fleet-a |
      | fleet-b |
    And every machine reached node convergence
    And every machine holds the commit under test
    And no machine is recorded as having the revision applied
    And no machine has a schedule of its own that runs fleet-sync

  Scenario: A failed canary stops promotion, and the machine after it is still inspected
    Given every machine has been bootstrapped
    And another fleet operation holds "fleet-a"
    When fleet-sync applies the commit under test with "fleet-a" as its canary
    Then "fleet-a" reports "FLEET_REMOTE_LOCKED" with a remedy
    And the checks of "fleet-b" include a passing "ssh:fresh-session"
    And the last check of "fleet-b" says "FLEET_PROMOTION_BLOCKED"
    And no fleet operation ran on "fleet-b"

  Scenario: A second run at the same time is refused by the remote lock, and the first completes
    Given every machine has been bootstrapped
    When a second bootstrap of "fleet-b" starts while a first one holds it
    Then the second bootstrap reports "FLEET_REMOTE_LOCKED" with a remedy
    And the first bootstrap reaches node convergence

  Scenario: The manager's connection drops during a package installation, and the machine keeps the lock until it ends
    The script ignores the hangup and keeps its lock: a later run must not
    start a second installer beside the one still running.
    Given every machine has been bootstrapped
    And "fleet-b" lacks the bootstrap package "unzip"
    When the manager's SSH connection to "fleet-b" drops while APT runs there
    Then the remote operation lock of "fleet-b" was still held after the connection dropped
    And once that operation has ended, the next bootstrap of "fleet-b" reaches node convergence
    And the package "unzip" is installed on "fleet-b"

  Scenario: An interrupted checkout of the revision is resumed, not reset
    Given every machine has been bootstrapped
    And "fleet-b" holds the checkout of the commit under test as an interrupted checkout left it: no commit, and "README.md" half written
    When the manager bootstraps "fleet-b"
    Then the bootstrap reaches node convergence
    And "fleet-b" holds the commit under test with no uncommitted change

  Scenario: An interrupted checkout holding a file of no revision is refused, not reset
    Given every machine has been bootstrapped
    And "fleet-b" holds the checkout of the commit under test as an interrupted checkout left it: no commit, and "notes.txt" written by someone
    When the manager bootstraps "fleet-b"
    Then the bootstrap reports "SOURCE_CHECKOUT_CONFLICT" with a remedy
    And "notes.txt" is still in that checkout on "fleet-b"

  Scenario: A package installation fleet-sync started and that was interrupted is finished on the next run
    Given every machine has been bootstrapped
    And "fleet-b" lacks the bootstrap package "unzip"
    And a package installation fleet-sync started on "fleet-b" was interrupted after unpacking "unzip"
    When the manager bootstraps "fleet-b"
    Then the bootstrap reaches node convergence
    And the package "unzip" is installed on "fleet-b"

  Scenario: An interrupted package installation fleet-sync did not start is left to the operator
    Given every machine has been bootstrapped
    And "fleet-b" lacks the bootstrap package "unzip"
    And a package installation someone else started on "fleet-b" was interrupted after unpacking "unzip"
    When the manager bootstraps "fleet-b"
    Then the bootstrap reports "DPKG_INTERRUPTED" with a remedy that says "dpkg --configure -a"

  Scenario: A toolchain setup killed midway completes on the next run, and leaves no installer behind
    Given every machine has been bootstrapped
    And "fleet-b" must set its toolchain up again
    When every process of the toolchain setup on "fleet-b" is killed while it runs
    Then the interrupted bootstrap did not reach node convergence
    And the next bootstrap of "fleet-b" reaches node convergence
    And no installer is left running on "fleet-b"

  Scenario Outline: <fault> stops the bootstrap within <seconds> seconds and names its remedy
    Given every machine has been bootstrapped
    And "fleet-b" lacks the bootstrap package "unzip"
    And <fault> on "fleet-b"
    When the manager bootstraps "fleet-b"
    Then the bootstrap reports "<code>" with a remedy
    And it took less than <seconds> seconds
    And the package "unzip" is not installed on "fleet-b"

    Examples:
      | fault                                           | code                | seconds |
      | another process holds the APT lock              | APT_LOCK_CONTENDED  | 300     |
      | the name of the Ubuntu archive cannot be found  | APT_DNS_UNAVAILABLE | 180     |

  Scenario: A machine whose host key changed is not touched
    Given every machine has been bootstrapped
    And the host key the manager trusts for "fleet-b" is not the one it presents
    When the manager bootstraps "fleet-b"
    Then the bootstrap reports the check "ssh:host-key"
    And the fleet configuration on "fleet-b" was not written again

  Scenario: A machine with too little disk is refused before anything is installed
    Given a fresh Ubuntu 26.04 machine "fleet-small" whose home has 64 MB free
    When the manager bootstraps "fleet-small"
    Then the bootstrap reports "BOOTSTRAP_DISK_CAPACITY_REQUIRED" with a remedy
    And "fleet-small" still has none of these commands:
      | git     |
      | curl    |
      | python3 |
