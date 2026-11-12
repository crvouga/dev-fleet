Feature: Every failure code has a runbook, and the documents quote real commands
  A failure code is the summary of a check, the code a bootstrap phase dies
  with or the code an Ansible assertion fails with. docs/runbooks.md has one
  entry for each: what it means, how to confirm it, the fix and when to
  escalate. A command the documents quote has to exist, or an operator
  following them runs into an error instead of a fix.

  Scenario: Every failure code in the source has an entry in the runbooks
    When the failure codes of the source are collected
    Then there are more than 200 of them
    And each has an entry in "docs/runbooks.md"
    And "docs/runbooks.md" has no entry for a code the source does not report

  Scenario: The runbooks count the codes, and the ones that need a person
    When the failure codes of the source are collected
    Then "docs/runbooks.md" states how many codes there are and how many need a person

  Scenario: Every devfleet command the documents quote exists
    When the devfleet commands quoted in the documents are read
    Then there are more than 20 of them
    And each is a command of the devfleet CLI

  Scenario: The documents quote no earlier executable or package
    When the documents are searched for an earlier executable or package
    Then nothing is found
