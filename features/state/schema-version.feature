Feature: The fleet state database carries its schema version
  The schema is a series of numbered migrations. A database records the last
  one it received in its `user_version`, a dev-fleet brings an older database
  forward before it writes, and refuses one a newer dev-fleet wrote: a
  rollback, or an old second manager, must not read or damage it.

  Scenario: The migrations are numbered from 1, without a gap
    Then the state migrations are numbered from 1 without a gap
    And the schema version this dev-fleet writes is that of the last migration

  Scenario: A new fleet state records the schema version
    Given a manager without a fleet state
    When the configuration is stored as '{"a":1}'
    Then the state database has the schema version this dev-fleet writes

  Scenario: A fleet state written before the schema had a version is brought forward
    The first released fleet state set no version. It holds exactly the
    documents and the head.
    Given the state database was written by a dev-fleet without a schema version, holding the configuration '{"old":true}'
    When the roster is stored as '{"b":2}'
    Then the state database has the schema version this dev-fleet writes
    And the fleet state holds the configuration '{"old":true}'
    And the fleet state holds the roster '{"b":2}'
    And the fleet state of the manager has no manager lease

  Scenario Outline: A fleet state from a newer dev-fleet is refused when it <is used>, and nothing is written
    Given the configuration was stored as '{"a":1}'
    And the state database was given the schema version 99
    When the <document> <is used>
    Then it is refused with "FLEET_STATE_NEWER_THAN_CLI"
    And the state database is byte for byte what it was

    Examples:
      | document      | is used                 |
      | configuration | is read from the fleet state |
      | roster        | is stored as '{"b":2}'  |

  Scenario: A bucket that holds a fleet state from a newer dev-fleet is refused, not taken for unreachable
    Given managers "a" and "b" replicate to one bucket
    And manager "a" changed the configuration to "one"
    And the fleet state in the bucket was given the schema version 99
    When manager "b" compares its copy with the bucket
    Then it is refused with "FLEET_STATE_NEWER_THAN_CLI"
