Feature: A rotated GitHub token is adopted while the old one still works
  After the token in the store is replaced, every node takes the new one on
  the next run of its sign-in job (every ten minutes, and at every sync),
  without waiting for the old one to stop working. The old token can be
  revoked once every node says it uses the stored one; no request fails on
  the way.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "OLD_TOKEN_PRIVATE_01" as "example-user"
    And GitHub knows the token "NEW_TOKEN_PRIVATE_02" as "example-user"
    And "worker-one" is signed in with "OLD_TOKEN_PRIVATE_01"
    And "worker-two" is signed in with "OLD_TOKEN_PRIVATE_01"
    And the store holds "NEW_TOKEN_PRIVATE_02" as "github-token"

  Scenario: Every node adopts the new token in one run of its job, and no request fails
    When the GitHub sign-in job runs on each of these nodes, in order:
      | worker-one |
      | worker-two |
    Then each of these nodes holds the token "NEW_TOKEN_PRIVATE_02":
      | worker-one |
      | worker-two |
    And each of these nodes reports that it adopted the stored token:
      | worker-one |
      | worker-two |
    And no request to GitHub failed
    And once "OLD_TOKEN_PRIVATE_01" is revoked, GitHub still answers each of these nodes:
      | worker-one |
      | worker-two |

  Scenario: Until a node has adopted the stored token, it says its token is stale
    When the GitHub checks run on "worker-two"
    Then the check "github:token-current" fails
    And the check "github:token-current" says "GITHUB_TOKEN_STALE"
    And the remedy of the check "github:token-current" mentions "Revoke the old token only when every node passes"
    And the check "github:principal" passes
    And nothing reported contains "PRIVATE"

  Scenario: A node that adopted the stored token says so
    Given "worker-two" is signed in with "NEW_TOKEN_PRIVATE_02"
    When the GitHub checks run on "worker-two"
    Then the check "github:token-current" passes

  Scenario: A node that already uses the stored token is not signed in again
    Given "worker-one" is signed in with "NEW_TOKEN_PRIVATE_02"
    When the GitHub sign-in job runs on "worker-one"
    Then the result on "worker-one" is "GITHUB_OK"
    And no command line contains "auth login"

  Scenario: A stored token GitHub refuses is not adopted, and the node keeps the one that works
    Given GitHub has revoked the token "NEW_TOKEN_PRIVATE_02"
    When the GitHub sign-in job runs on "worker-one"
    Then the result on "worker-one" is "GITHUB_TOKEN_REJECTED"
    And "worker-one" holds the token "OLD_TOKEN_PRIVATE_01"
