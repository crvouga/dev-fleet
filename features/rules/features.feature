Feature: What dev-fleet does is specified in Gherkin
  A feature says what is true in the words of someone who runs a fleet, and
  the steps beside it check it. The TypeScript has no other tests.

  Scenario: Every TypeScript test file hands an area's features to the runner
    When the TypeScript test files in the repository are listed
    Then there is at least one
    And each is the "features.test.ts" of a directory under "features"

  Scenario: Every area under features has a specification
    When the areas under "features" are listed
    Then there is at least one
    And each holds at least one ".feature" file
    And each holds a "features.test.ts"

  Scenario: A scenario has one thing that happens
    When every scenario of every feature is read
    Then there are more than 500 scenarios
    And none has more than one "When" step
