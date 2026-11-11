Feature: dev-fleet is the lower layer
  The CLI and Workstation may use dev-fleet, never the other way round. Code
  they share moves into this package instead.

  Scenario: No source file imports Workstation or the personal CLI
    When every source file is searched for imports from these sibling packages:
      | workstation  |
      | personal-cli |
    Then no such import is found
