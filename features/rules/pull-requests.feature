Feature: A pull request reaches a release with nobody attending
  Most changes are made by agents, many at once. A pull request is merged the
  moment its checks pass, the merge is checked on main and released, and
  whatever breaks on main says so in an issue an agent can pick up.

  Scenario: One check stands for every job of a pull request
    The ruleset of main requires this one check, so a job that is added,
    renamed or split is required from the pull request that does it.
    Then every other job of the "CI" workflow is needed by its "required" job
    And its "required" job runs whatever became of them
    And its "required" job runs "all(.[]; .result == \"success\")"

  Scenario: A newer push replaces the run of a pull request, and a run on main is never cut short
    A run that is cut short on main releases nothing, so merges that follow
    one another closely would never be released.
    Then the "CI" workflow cancels a run in progress only for "pull_request"

  Scenario: Adding a label to a pull request does not start its checks again
    Then the "CI" workflow runs on "pull_request" only when one is:
      | opened      |
      | synchronize |
      | reopened    |

  Scenario: Every pull request from a branch of the repository merges itself
    Then the "Auto-merge" workflow runs on "pull_request"
    And its "enable" job runs "gh pr merge --auto --squash"
    And the "Auto-merge" workflow runs on "schedule"
    And its "reconcile" job runs "gh pr merge --repo \"$REPO\" --auto --squash"

  Scenario: A merge that started no checks on main gets them
    A merge made with a workflow's own token starts no workflow. The end of a
    CI run (which is what merges a pull request) and every hour start CI on
    main when its newest commit has no run, and the release follows that run.
    Then the "Auto-merge" workflow runs on "workflow_run"
    And the "Auto-merge" workflow runs on "schedule"
    And its "reconcile" job runs "gh workflow run ci.yml"
    And the "CI" workflow runs on "workflow_dispatch"
    And the "Release" workflow follows the "CI" workflow

  Scenario: A pull request a workflow opens is checked like any other
    Then the "Pins" workflow runs on "schedule"
    And its "pin" job runs "gh workflow run ci.yml --ref \"$branch\""

  Scenario: Every workflow that runs on main has an issue while it fails there
    When the workflows that run in this repository by themselves are listed
    Then there is at least one
    And each is followed by the "Failure issues" workflow

  Scenario: The issue of a failing workflow is opened once, kept current and closed by the first passing run
    When the "Open, update or close the issue of this workflow" step of the "Failure issues" workflow is read
    Then it runs "gh issue close" before "gh issue create"
    And it runs "gh issue create" before "gh issue edit"
    And the "Failure issues" workflow follows no run of a pull request

  Scenario: A failed VM test keeps its evidence
    Then the "Ubuntu VM" workflow runs on "workflow_dispatch"
    And its "vm" job keeps "~/.cache/fleet-vm-*/vm/*.log" when it fails
