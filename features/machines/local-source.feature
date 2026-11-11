Feature: A local checkout supplies only a commit it really holds
  The manager may take the commit to deploy from a checkout on its own disk.
  It takes committed objects, never files of the working tree, and only from a
  checkout of the repository the fleet configuration names that holds exactly
  that commit. Nothing is fetched, checked out or staged to find out.

  Background:
    Given the fleet configuration names the source repository "https://github.com/crvouga/dev-fleet.git"

  Scenario: A checkout of the fleet's repository that holds the commit supplies it
    Given these commands answer:
      | command                                                                  | answer                                            |
      | git rev-parse --show-toplevel                                            | prints /repo\n                                    |
      | git remote get-url origin                                                | prints https://github.com/crvouga/dev-fleet\n     |
      | git rev-parse --verify aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit} | prints aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n |
    When the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is looked for in the checkout "/repo"
    Then the checkout "/repo" supplies it
    And 3 commands ran
    And no command with any of these words was run:
      | fetch    |
      | checkout |
      | reset    |
      | add      |

  Scenario Outline: <which checkout> cannot supply the commit
    Given these commands answer:
      | command                                                                  | answer          |
      | git rev-parse --show-toplevel                                            | prints /repo    |
      | git remote get-url origin                                                | prints <origin> |
      | git rev-parse --verify aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit} | fails           |
    When the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is looked for in the checkout "/repo"
    Then no checkout supplies it

    Examples:
      | which checkout                                          | origin                                   |
      | A checkout of another repository                        | https://github.com/other/repo.git        |
      | A checkout of the fleet's repository without the commit | https://github.com/crvouga/dev-fleet.git |
