Feature: One manager at a time holds the lease on the fleet state
  The fleet state carries a lease: which machine is the manager, and until
  when. It travels to the bucket with every change, so a second manager (a
  replacement, or an old one that wakes up) reads it from the bucket and is
  refused before it writes anything. A lease runs for seven days from the
  last change; an expired one, or `--take-over`, lets another machine in.

  Background:
    Given managers "a" and "b" replicate to one bucket
    And managers "a" and "b" are told apart by the manager lease
    And manager "a" changed the configuration to "from a"

  Scenario: The manager that changed the fleet state holds the lease
    Then the fleet state of manager "a" names "a" in the manager lease
    And the lease of manager "a" expires 7 days after its change

  Scenario: The lease reaches the bucket
    When manager "b" refreshes its copy
    Then the fleet state of manager "b" names "a" in the manager lease

  Scenario: A second manager is refused before it writes
    When manager "b" changes the configuration to "from b"
    Then it is refused with "FLEET_MANAGER_LEASE_HELD"
    And the fleet state of manager "b" holds the configuration "from a"
    And manager "b" has nothing waiting for the bucket

  Scenario: Nothing of the second manager reaches the bucket
    Given manager "b" tried to change the configuration to "from b"
    When manager "a" refreshes its copy
    Then the refresh reports "in-sync" and an unchanged copy
    And the fleet state of manager "a" holds the configuration "from a"

  Scenario: The holder keeps changing the fleet state
    When manager "a" changes the roster to "a roster"
    Then it reports "in-sync"

  Scenario: An expired lease lets another manager take it
    Given the clock of manager "b" is 8 days ahead
    When manager "b" changes the configuration to "from b"
    Then it reports "in-sync"
    And the fleet state of manager "b" names "b" in the manager lease

  Scenario: --take-over takes an unexpired lease, and the first manager is refused afterwards
    Given manager "b" takes over the manager lease
    And manager "b" changed the configuration to "from b"
    When manager "a" changes the configuration to "from a again"
    Then it is refused with "FLEET_MANAGER_LEASE_HELD"

  Scenario: Connecting a second manager to the bucket restores the fleet state and takes no lease
    When the operator runs "fleet-state --init --directory $BUCKET" on manager "b"
    Then the command exits 0
    And the output contains "FLEET_MANAGER_LEASE_HELD"
    And the fleet state of manager "b" holds the configuration "from a"
    And the fleet state of manager "b" names "a" in the manager lease

  Scenario: fleet-state --import from a second manager is refused with the lease's code
    Given the operator ran "fleet-state --init --directory $BUCKET" on manager "b"
    When the operator runs "fleet-state --import examples/fleet.json" on manager "b"
    Then it is refused with "FLEET_MANAGER_LEASE_HELD"

  Scenario: fleet-state --import --take-over makes the second machine the manager
    Given the operator ran "fleet-state --init --directory $BUCKET" on manager "b"
    When the operator runs "fleet-state --import examples/fleet.json --take-over" on manager "b"
    Then the report includes:
      """
      { "standing": "in-sync" }
      """
    And the fleet state of manager "b" names "b" in the manager lease

  Rule: Restoring an earlier version replaces the bucket only for the manager that holds the lease
    `--restore --timestamp --yes` uploads the earlier version as the bucket's
    current one. `--yes` consents to that, not to replacing another manager:
    whatever that manager recorded since would be gone from both sides. When
    the bucket's current version cannot be read, the lease this machine last
    saw decides.

    Background:
      Given the time was noted
      And manager "a" changed the configuration to "later"
      And the operator ran "fleet-state --init --directory $BUCKET" on manager "b"

    Scenario: A second manager is refused before it replaces the bucket
      When the operator runs "fleet-state --restore --timestamp $NOTED --yes" on manager "b"
      Then it is refused with "FLEET_MANAGER_LEASE_HELD"
      And the fleet state of manager "b" holds the configuration "later"
      And manager "a" stands "in-sync" with the bucket

    Scenario: The manager that holds the lease restores an earlier version
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      When the operator runs "fleet-state --restore --timestamp $NOTED --yes" on manager "a"
      Then the report includes:
        """
        { "standing": "in-sync" }
        """
      And the fleet state of manager "a" holds the configuration "from a"
      And the fleet state of manager "a" names "a" in the manager lease

    Scenario: --take-over restores an earlier version and makes the second machine the manager
      Given the operator ran "fleet-state --restore --timestamp $NOTED --yes --take-over" on manager "b"
      When manager "a" changes the configuration to "from a again"
      Then it is refused with "FLEET_MANAGER_LEASE_HELD"
      And the fleet state of manager "a" holds the configuration "from a"
      And the fleet state of manager "a" names "b" in the manager lease

    Scenario: On a corrupt replica the lease this machine last saw refuses a second manager
      Given the bucket's latest version was cut short
      When the operator runs "fleet-state --restore --timestamp $NOTED --yes" on manager "b"
      Then it is refused with "FLEET_MANAGER_LEASE_HELD"

    Scenario: On a corrupt replica the manager that holds the lease restores an earlier version
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      And the bucket's latest version was cut short
      When the operator runs "fleet-state --restore --timestamp $NOTED --yes" on manager "a"
      Then the report includes:
        """
        { "standing": "in-sync" }
        """
      And the fleet state of manager "a" holds the configuration "from a"
