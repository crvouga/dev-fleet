Feature: The GitHub work of an agent is verified end to end
  fleet-github-verify does on the declared sandbox repository what an agent
  does: clone, branch, commit, push, open a draft pull request, read its
  checks and comment. It then closes the pull request and deletes the branch,
  whatever failed, and names the first step that failed.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And "worker-one" is signed in with "TOKEN_A_PRIVATE_0001"
    And the fleet's github block is:
      """
      { "sandbox": "example-org/sandbox" }
      """

  Scenario: The whole chain passes and leaves nothing behind
    When the GitHub workflow is verified from "worker-one"
    Then the check "github:workflow" passes
    And the sandbox has no branch and no open pull request left

  Scenario Outline: A node that cannot <action> fails at "<step>" and still cleans up
    Given the sandbox refuses the step "<step>"
    When the GitHub workflow is verified from "worker-one"
    Then the check "github:workflow" fails
    And the check "github:workflow" says "GITHUB_WORKFLOW_FAILED: <step>"
    And the sandbox has no branch and no open pull request left

    Examples:
      | action                  | step         |
      | push                    | push         |
      | open a pull request     | pull-request |
      | read checks             | read-checks  |
      | comment                 | comment      |

  Scenario: A node with no identity for commits fails at the commit
    Given git on "worker-one" has no identity to commit with
    When the GitHub workflow is verified from "worker-one"
    Then the check "github:workflow" says "GITHUB_WORKFLOW_FAILED: commit"
    And the remedy of the check "github:workflow" mentions "user.email"

  Scenario: A node without a GitHub sign-in fails at the clone
    Given "worker-one" is not signed in to GitHub
    When the GitHub workflow is verified from "worker-one"
    Then the check "github:workflow" says "GITHUB_WORKFLOW_FAILED: clone"

  Scenario: A clean-up that fails names what it left behind
    Given the sandbox refuses the step "close"
    When the GitHub workflow is verified from "worker-one"
    Then the check "github:workflow" fails
    And the check "github:workflow" says "GITHUB_WORKFLOW_CLEANUP_FAILED: https://github.com/example-org/sandbox/pull/1"

  @slow
  Scenario: A hundred runs leave no branch and no pull request behind
    When the GitHub workflow is verified 100 times from "worker-one"
    Then every run passed, each on a branch of its own
    And the sandbox has no branch and no open pull request left

  Scenario: Without a declared sandbox, the command says what to declare
    Given the fleet's github block is:
      """
      {}
      """
    When the GitHub workflow is verified from "worker-one"
    Then it is refused, saying "Declare github.sandbox"
