Feature: The health of the managed fleet covers the manager and the declared workers
  The scope is this computer and the workers the fleet configuration declares.
  Other peers on the tailnet are named as left out, and a declared worker that
  is not enrolled is a failure, not a gap.

  Scenario: The manager and declared workers stay in scope, service peers are left out and missing enrollments fail
    Given the tailnet shows these computers:
      | id                           | name                         | dns                          | os    | address    | online | this computer |
      | manager                      | manager                      | manager                      | linux | 100.64.0.1 | yes    | yes           |
      | worker-one.tail0a1b2c.ts.net | worker-one.tail0a1b2c.ts.net | worker-one.tail0a1b2c.ts.net | linux | 100.64.0.1 | yes    | no            |
      | worker-two.tail0a1b2c.ts.net | worker-two.tail0a1b2c.ts.net | worker-two.tail0a1b2c.ts.net | linux | 100.64.0.1 | yes    | no            |
      | service.example              | service.example              | service.example              | linux | 100.64.0.1 | yes    | no            |
    And the tailnet left out 1 mobile device
    And the roster enrolls nobody
    When the scope of the managed fleet's health is worked out
    Then 3 computers are in scope
    And the computers left out are exactly:
      | service.example |
    And 2 checks are reported for the tailnet, every one with the status "fail"

  Scenario: Enrolled declared workers stay, and other roster entries do not widen the scope
    Given the tailnet shows no computer
    And the roster enrolls:
      | id         | ssh        | workspace |
      | worker-one | worker-one | /repo     |
      | worker-two | worker-two | /repo     |
      | service    | service    | /service  |
    When the scope of the managed fleet's health is worked out
    Then 2 roster entries are in scope
    And no check is reported for the tailnet
