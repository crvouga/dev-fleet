Feature: The manager runs its own agent as a launch agent of its user
  The manager is always a system on its own hub. Its agent is installed on the
  manager itself, never over SSH, as a launch agent of the signed-in user: no
  sudo, so fleet-sync on the manager stays unattended.

  Background:
    Given the agent is enrolled as:
      | system     | abcdefghijklmno                 |
      | hub        | https://hub.example.ts.net:8443 |
      | public key | ssh-ed25519 fixture             |
      | token      | fixture-token-0123456789        |
    And the playbook "agent-darwin.yml" succeeds
    And no apply leaves a receipt

  Scenario: The agent is installed by a playbook and measured with launchctl: no sudo, no secret in an argument
    Given these commands answer:
      | command                                                | answer                 |
      | /bin/launchctl print gui/501/dev.devfleet.beszel-agent | prints state = running |
    When the manager "manager", whose user is 501, installs its own agent from the package at "/repo"
    Then the first command ran the playbook "agent-darwin.yml"
    And the second command was "/bin/launchctl print gui/501/dev.devfleet.beszel-agent"
    And no command with the word "sudo" was run
    And no command contains "fixture-token-0123456789"
    And the check is "beszel:service"
    And the check passes

  Scenario: A stopped agent fails
    Given these commands answer:
      | command                                                | answer                 |
      | /bin/launchctl print gui/501/dev.devfleet.beszel-agent | prints state = waiting |
    When the manager "manager", whose user is 501, installs its own agent from the package at "/repo"
    Then the summary of the check is "BESZEL_SERVICE_STOPPED"
