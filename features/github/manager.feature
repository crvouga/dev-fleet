Feature: The manager's GitHub sign-in is checked like every worker's
  The manager is where a person drives the fleet from. It is held to the fleet
  login by default, or to a person's own login the fleet configuration names
  under github.manager. A personal login is checked and never replaced.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And GitHub knows the token "TOKEN_P_PRIVATE_0004" as "someone"
    And GitHub knows the token "TOKEN_X_PRIVATE_0005" as "someone-else"
    And the store holds "TOKEN_A_PRIVATE_0001" as "github-token"

  Scenario: fleet-status shows the GitHub checks of the manager
    Given "manager-mac" is signed in with "TOKEN_A_PRIVATE_0001"
    And every other command fails
    When fleet-status checks the "github" capability on the manager
    Then these checks are reported, in this order:
      | auth:github           |
      | github:principal      |
      | github:token-current  |
      | github:permissions    |
      | github:expiry         |
      | github:rate-limit     |
      | github:git-credential |
    And the check "github:principal" passes

  Scenario: By default the manager signed in as another account fails
    Given "manager-mac" is signed in with "TOKEN_X_PRIVATE_0005"
    When the GitHub checks run on the manager
    Then the check "github:principal" fails
    And the check "github:principal" says "GITHUB_LOGIN_MISMATCH"

  Rule: A manager with a personal login

    Background:
      Given the fleet's github block is:
        """
        { "manager": { "login": "someone" } }
        """

    Scenario: The declared personal login passes, and its token is not compared with the store
      Given "manager-mac" is signed in with "TOKEN_P_PRIVATE_0004"
      When the GitHub checks run on the manager
      Then the check "github:principal" passes
      And no check "github:token-current" is reported

    Scenario: An account the configuration does not declare fails
      Given "manager-mac" is signed in with "TOKEN_X_PRIVATE_0005"
      When the GitHub checks run on the manager
      Then the check "github:principal" fails
      And the remedy of the check "github:principal" mentions "never replaces a personal login"

    Scenario: The sign-in job measures a personal login and never replaces it
      Given "manager-mac" is signed in with "TOKEN_P_PRIVATE_0004"
      When the GitHub sign-in job runs on the manager
      Then "manager-mac" holds the token "TOKEN_P_PRIVATE_0004"
      And no command line contains "auth login"
