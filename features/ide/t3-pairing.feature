Feature: The roster remembers which T3 environment each worker runs
  The first time a verified link from the manager reaches a worker, the
  environment it runs is recorded in the roster. From then on a worker whose
  T3 data was replaced is told apart from one that is only offline.

  Background:
    Given a roster file that enrolls the worker "dev-one"
    And the worker reports the T3 environment "11111111-2222-3333-4444-555555555555" over SSH

  Scenario: A worker reached for the first time is recorded
    Given the T3 of the manager links to "11111111-2222-3333-4444-555555555555", reachable for 30 days
    When the manager checks the T3 of the worker
    Then the roster enrolls "dev-one" with the T3 environment "11111111-2222-3333-4444-555555555555"

  Scenario: A worker the manager cannot reach is not recorded
    Given the T3 of the manager has no links
    When the manager checks the T3 of the worker
    Then the roster enrolls "dev-one" with no T3 environment

  Scenario: An environment already recorded is never rewritten
    Given the roster already enrolls "dev-one" with the T3 environment "99999999-2222-3333-4444-555555555555"
    When the environment "11111111-2222-3333-4444-555555555555" is recorded for "dev-one"
    Then the roster enrolls "dev-one" with the T3 environment "99999999-2222-3333-4444-555555555555"

  Scenario: Something that is not an environment ID is refused
    When the environment "not-an-id" is recorded for "dev-one"
    Then recording is refused
    And the roster enrolls "dev-one" with no T3 environment
