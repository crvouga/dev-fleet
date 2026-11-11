Feature: The fleet state is a private database of documents
  The manager keeps what it cannot rebuild from Git as three documents in one
  database: the configuration (`definition`), the `roster` and the
  `enrollment`. Every change is a new version of the whole database, and the
  latest version is its head.

  Scenario: Reading a manager without a fleet state finds nothing and creates nothing
    Given a manager without a fleet state
    Then the fleet state holds no configuration
    And the fleet state has no head
    And the fleet state lists no documents
    And no state database exists

  Scenario: A document is stored privately
    Given a manager without a fleet state
    When the configuration is stored as '{"a":1}'
    Then that is version 1 of the fleet state
    And the state database is readable by its owner only
    And the fleet state holds the configuration '{"a":1}'

  Scenario: Every change advances the head
    Given the configuration was stored as '{"a":1}'
    When the roster is stored as '{"b":2}'
    Then that is version 2 of the fleet state
    And its head is not the head before it
    And the head of the fleet state is that version
    And the fleet state lists these documents:
      | definition |
      | roster     |

  Scenario: Storing the text already stored is not a new version
    Given the enrollment was stored as "same"
    When the enrollment is stored as "same"
    Then that is the version before it, unchanged
    And the head of the fleet state is that version

  Scenario: A document larger than 1 MiB is refused
    Given a manager without a fleet state
    When the configuration is stored as 1048577 characters
    Then it is refused with "smaller than 1 MiB"

  Scenario: A state database that cannot be read is refused with the way to restore it
    Given the configuration was stored as "{}"
    And the state database was overwritten with "not a database"
    When the configuration is read from the fleet state
    Then it is refused with "fleet-state --restore"
