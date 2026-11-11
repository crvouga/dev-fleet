Feature: The roster of workers
  The roster lists the workers a manager reaches: an ID, an SSH alias and a
  checkout path for each. It holds no secret, is written only when asked for
  twice (--apply --yes), and is never left half-written.

  Background:
    Given a project with no roster
    And devfleet at version "1.2.3"

  Rule: A fleet with no roster is a first run, not an error

    Scenario: Listing the workers of an unconfigured fleet finds none
      When the operator runs "devfleet fleet-nodes --json"
      Then it exits with 0
      And it answers with at least:
        """
        { "ok": true, "configured": false, "nodes": [] }
        """

    Scenario: Onboarding instructions need a roster
      When the operator runs "devfleet fleet-nodes --onboard --json"
      Then it exits with 2

    Scenario: A roster that cannot be parsed is refused
      Given the roster file reads "{broken"
      When the operator runs "devfleet fleet-nodes --json"
      Then it exits with 2

  Rule: Registering a worker is a preview until it is applied

    Scenario: Without --apply nothing is written
      When the operator runs "devfleet fleet-node-add --id first --ssh first --path /workspace --json"
      Then it exits with 0
      And no roster is written

    Scenario: With --apply --yes the worker is written
      When the operator runs "devfleet fleet-node-add --id first --ssh first --path /workspace --json --apply --yes"
      Then it exits with 0
      And the roster lists the workers "first"
      And only its owner can read or write the roster file

    Scenario: A worker added later is listed after the ones before it
      Given the operator has run "devfleet fleet-node-add --id first --ssh first --path /workspace --json --apply --yes"
      When this worker is added to the roster:
        | id     | ssh     | workspace           |
        | second | dev-one | /home/dev/workspace |
      Then the roster lists the workers "first, second"

  Rule: A roster that lists workers is kept as it is

    Background:
      Given the operator has run "devfleet fleet-node-add --id first --ssh first --path /workspace --json --apply --yes"
      And these workers are registered:
        | id     | ssh     | workspace           |
        | second | dev-one | /home/dev/workspace |

    Scenario: A worker that is already registered is refused and the roster is left as it was
      When the operator runs "devfleet fleet-node-add --id first --ssh first --path /workspace --json --apply --yes"
      Then it exits with 2
      And the roster file is as it was
      And only its owner can read or write the roster file

    Scenario: Onboarding a worker says how to verify it
      When the operator runs "devfleet fleet-nodes --onboard --node first --json"
      Then it answers with at least:
        """
        { "nodes": [{ "verifyCommand": "devfleet fleet-status --node first --json" }] }
        """

  Rule: The roster is never half-written

    Scenario: While another writer holds the lock, nothing is added
      Concurrent writers fail closed rather than lose entries.
      Given another writer holds the lock of the roster
      When this worker is added to the roster:
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      Then it is refused with "locked"
      And no roster is written

    @posix
    Scenario: A roster that is a symbolic link is refused and what it links to is left alone
      Given the roster is a symbolic link to a file that lists these workers:
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      When this worker is added to the roster:
        | id    | ssh     | workspace           |
        | other | dev-one | /home/dev/workspace |
      Then it is refused with "regular file"
      And the file the roster links to still lists 1 worker
