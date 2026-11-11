Feature: fleet-status checks the manager and its workers without changing them
  The manager is always checked. Workers are reached over SSH and run the
  probe the manager sends them; nothing is installed on a worker to check it.

  Background:
    Given a workspace with its dependency files and no roster
    And every command on this manager succeeds
    And a command with the argument "rev-parse" prints "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: Checking this manager only bundles no probe and asks no login it was not asked about
    When the operator runs "devfleet fleet-status --local --require none"
    Then the report covers exactly "manager"
    And in the answer, "coverage.scope" is "local"
    And only these programs were run:
      | git     |
      | ssh-add |
    And no probe was bundled for workers

  Scenario: Without a roster the manager is still checked, and the fleet is reported as unknown
    When the operator runs "devfleet fleet-status --all --require none"
    Then it exits with 1
    And the report covers "manager"
    And the check "fleet:roster" has the status "fail"
    And no probe was bundled for workers

  Rule: Workers are reached over SSH with the probe the manager supplies

    Background:
      Given these workers are registered:
        | id  | ssh     | workspace           |
        | one | dev-one | /home/dev/workspace |
        | two | dev-one | /home/dev/workspace |
      And the probe sent to workers is "standalone-probe-source"
      And every worker answers the probe as this workspace does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: With no scope named, every registered worker is checked
      When the operator runs "devfleet fleet-status --require none"
      Then the report covers exactly "manager, one, two"
      And 2 commands were run over SSH
      And every command run over SSH was given the probe "standalone-probe-source"

    Scenario: --node limits SSH to the worker it names
      When the operator runs "devfleet fleet-status --node two --require none"
      Then the report covers exactly "manager, two"
      And 1 command was run over SSH
      And every command run over SSH was given the probe "standalone-probe-source"
