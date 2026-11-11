Feature: Every fleet-sync on the manager runs through the manager run script
  Whether started on the manager or handed off from a worker, fleet-sync runs
  from a clean, fleet-owned checkout of the exact revision, so the result never
  depends on the working tree it was started in. Nobody keeps a clone of
  dev-fleet: the run script takes the revision from the repository fleet-sync
  prepared, or from the manager's own copy of the source repository.

  Background:
    Given a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called
    And the fleet's source repository holds the commit "first"

  Rule: The revision is checked out of a repository the manager owns

    Scenario: Started by fleet-sync, the revision is checked out of the repository fleet-sync prepared
      The toolchain bootstrap installs mise where there is none, then the CLI
      runs from the checkout.
      Given the manager has its own copy of the source repository
      When the run script is started for the commit "first" with "--json", from the repository fleet-sync prepared
      Then the run script exits with 0
      And the run checkout of the commit "first" is at that commit
      And the file "file" in the run checkout of the commit "first" holds "first"
      And the run script ran "bash bootstrap/bootstrap.sh --tools-only"
      And the last thing the run script ran is "mise exec --locked bun -- bun src/cli/cli.ts fleet-sync --revision {first} --json", where {first} is that commit

    Scenario: Handed off from a worker, a revision newer than anything the manager has fetched is fetched
      Nothing names a repository, so the manager's own copy is used.
      Given the manager has its own copy of the source repository
      And the fleet's source repository gains the commit "second"
      When the run script is started for the commit "second" with "--json"
      Then the run script exits with 0
      And the run checkout of the commit "second" is at that commit

    Scenario: A run checkout that is already there is reused
      Given the manager has its own copy of the source repository
      And the fleet's source repository gains the commit "second"
      And the run script has already run for the commit "second" with "--json"
      When the run script is started for the commit "second" with "--json"
      Then the run script exits with 0
      And this time the run script ran nothing that names "bootstrap.sh"

    Scenario: Without any source on the manager the hand-off says how to get one and changes nothing
      When the run script is started for the commit "first" with "--json"
      Then the run script exits with 3
      And the run script says "run fleet-sync once on the manager itself"
      And there is no directory of run checkouts

    Scenario: Anything but a full commit is refused
      When the run script is started for the revision "main" with "--json"
      Then the run script exits with 2

  Rule: Only the most recent run checkouts are kept

    Scenario: Older run checkouts are pruned, also the ones an earlier clone made
      The four older ones were left behind by runs from a clone that is gone:
      they are not worktrees of this repository. What remains is this run and
      the two most recent others.
      Given the manager has its own copy of the source repository
      And these run checkouts, each with its "node_modules", were left behind by an earlier clone:
        | name                                     | last used  |
        | 1111111111111111111111111111111111111111 | 2020-01-01 |
        | 2222222222222222222222222222222222222222 | 2020-01-02 |
        | 3333333333333333333333333333333333333333 | 2020-01-03 |
        | 4444444444444444444444444444444444444444 | 2020-01-04 |
      When the run script is started for the commit "first" with "--json"
      Then the run script exits with 0
      And the run checkouts that remain are that of the commit "first" and:
        | 3333333333333333333333333333333333333333 |
        | 4444444444444444444444444444444444444444 |
