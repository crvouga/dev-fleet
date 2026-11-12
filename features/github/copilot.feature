Feature: Copilot CLI is signed in through the node's GitHub sign-in
  Copilot CLI uses the token gh holds when it has none of its own, so one
  sync signs it in on every node; nobody runs copilot login node by node. The
  check reads only the kind of the token, never the token.

  Background:
    Given the fleet login is "example-user"

  Scenario Outline: A node signed in with <kind> <verdict>
    Given GitHub knows the token "<token>" as "example-user"
    And "worker-one" is signed in with "<token>"
    When the sign-in of Copilot CLI is checked on "worker-one"
    Then the check "auth:copilot" <verdict>
    And the check "auth:copilot" says "<summary>"
    And nothing reported contains "<token>"

    Examples:
      | kind                    | token                      | verdict | summary                         |
      | an OAuth token          | gho_PRIVATE_OAUTH_TOKEN_01 | passes  | uses this node’s GitHub sign-in |
      | a fine-grained token    | github_pat_PRIVATE_000001  | passes  | uses this node’s GitHub sign-in |
      | a classic token         | ghp_PRIVATE_CLASSIC_000001 | fails   | COPILOT_TOKEN_UNSUPPORTED       |

  Scenario: A node with no GitHub sign-in is not signed in to Copilot
    Given "worker-one" is not signed in to GitHub
    When the sign-in of Copilot CLI is checked on "worker-one"
    Then the check "auth:copilot" fails
    And the check "auth:copilot" says "not-signed-in"
    And no command line contains "login"

  Scenario: A node without Copilot CLI is skipped
    Given Copilot CLI is not installed
    When the sign-in of Copilot CLI is checked on "worker-one"
    Then the check "auth:copilot" is skipped
