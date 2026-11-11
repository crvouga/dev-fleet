Feature: The devfleet CLI answers in JSON and changes nothing until it is told to
  Every command here is the real CLI, started in an empty directory that is
  no checkout and holds no roster. A command that would change something only
  previews it until `--apply` is given, and no command repeats back what was
  typed at it.

  Background:
    Given an empty directory

  Scenario Outline: "<command>" works without a roster or credentials
    When the operator runs "<command>"
    Then the process succeeds
    And it prints a JSON object
    And it prints nothing to its error output

    Examples:
      | command                              |
      | devfleet fleet-nodes --schema --json |
      | devfleet fleet-nodes --json          |

  Rule: Registering a worker previews, then writes once

    Scenario: Without --apply a registration is only previewed
      When the operator runs "devfleet fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --config roster.json --json"
      Then the answer says "applied" is false
      And the file "roster.json" does not exist

    Scenario: An applied registration writes the roster
      When the operator runs "devfleet fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --config roster.json --json --apply --yes"
      Then the process succeeds
      And the file "roster.json" is a roster of version 1

    Scenario: A worker that is registered is never overwritten
      Given the operator has run "devfleet fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --config roster.json --json --apply --yes"
      When the operator runs "devfleet fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --config roster.json --json --apply --yes"
      Then the process fails
      And the file "roster.json" is as it was before the command

  Rule: Looking at repairs and onboarding applies nothing

    Background:
      Given the operator has run "devfleet fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --config roster.json --apply --yes"

    Scenario: Listing the repairs of a registered worker succeeds without reaching it
      When the operator runs "devfleet fleet-repair --list --config roster.json --yes --json"
      Then the process succeeds
      And the answer says "ok" is true

    Scenario: Onboarding prints the SSH configuration to add and applies nothing
      When the operator runs "devfleet fleet-nodes --onboard --config roster.json --json"
      Then the "sshTemplate" of the first worker in the answer contains "IdentitiesOnly yes"
      And the first worker in the answer says "applied" is false

  Rule: A mistake in usage is answered without repeating it

    Scenario: A usage error is JSON and never echoes the value of an option
      A value typed at the wrong option may be a secret.
      When the operator runs "devfleet fleet-status --unrecognized-secret=never-print-this"
      Then the process fails
      And the answer says "code" is "invalid_usage"
      And "never-print-this" appears nowhere in what the process printed
