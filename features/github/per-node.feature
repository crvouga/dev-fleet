Feature: Each node may have a GitHub token of its own
  With github.credential "per-node", each node reads its own token under a
  name of its own. One leaked or revoked token then concerns one node, and
  the nodes no longer share one rate limit.

  Background:
    Given the fleet login is "example-user"
    And the fleet's github block is:
      """
      { "credential": "per-node" }
      """
    And GitHub knows the token "TOKEN_1_PRIVATE_0001" as "example-user"
    And GitHub knows the token "TOKEN_2_PRIVATE_0002" as "example-user"
    And the store holds "TOKEN_1_PRIVATE_0001" as "github-token-worker-one"
    And the store holds "TOKEN_2_PRIVATE_0002" as "github-token-worker-two"

  Scenario: Each worker is signed in with its own token
    Given "worker-one" is not signed in to GitHub
    And "worker-two" is not signed in to GitHub
    When the GitHub sign-in job runs on each of these nodes, in order:
      | worker-one |
      | worker-two |
    Then "worker-one" holds the token "TOKEN_1_PRIVATE_0001"
    And "worker-two" holds the token "TOKEN_2_PRIVATE_0002"

  Scenario: Revoking one node's token leaves the others signed in
    Given "worker-one" is signed in with "TOKEN_1_PRIVATE_0001"
    And "worker-two" is signed in with "TOKEN_2_PRIVATE_0002"
    And GitHub has revoked the token "TOKEN_1_PRIVATE_0001"
    When the GitHub sign-in job runs on each of these nodes, in order:
      | worker-one |
      | worker-two |
    Then the result on "worker-one" is "GITHUB_TOKEN_REJECTED"
    And the result on "worker-two" is "GITHUB_OK"

  Scenario Outline: The token of "worker-one" is kept as <where> with the "<provider>" provider
    Then with the "<provider>" provider the token of "worker-one" is kept as "<where>"

    Examples:
      | provider | where                                     |
      | env      | DEVFLEET_SECRET_GITHUB_TOKEN_WORKER_ONE   |
      | file     | github-token-worker-one                   |
      | sops     | github-token-worker-one                   |
      | vault    | fleet/prd GITHUB_TOKEN_WORKER_ONE         |
