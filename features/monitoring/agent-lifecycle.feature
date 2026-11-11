@agent-box @slow
Feature: The agent's playbook converges a real machine and repairs it
  The playbook that installs the monitoring agent runs, unchanged, on a
  disposable Ubuntu machine booted with systemd. The hub it is given is not
  reachable: this proves the agent's lifecycle and its isolation, not its
  metrics. Runs only when DEVFLEET_TEST_AGENT_BOX is set, because it
  downloads the pinned agent.

  Background:
    Given a disposable Ubuntu 26.04 machine booted with systemd
    And the agent was installed there by "agent.yml" for the hub "https://hub.fixture.ts.net:8443"

  Scenario: Installing the agent again changes nothing and does not restart it
    When "agent.yml" applies again
    Then it changed nothing
    And the agent kept its process

  Scenario: An edited unit is put back and the agent restarted on it
    Given someone changed "RestartSec=20" to "RestartSec=1" in the agent's unit
    When "agent.yml" applies again
    Then the agent's unit is the tracked "ansible/monitoring/beszel-agent.service"
    And the agent is running

  Scenario: An executable an interrupted upgrade cut short is replaced
    A running executable cannot be written, so an upgrade is interrupted while
    the agent is stopped.
    Given the agent is stopped and its executable was cut to 4096 bytes
    When "agent.yml" applies again
    Then the agent's executable is the build the Beszel lock pins for this machine
    And the agent is running

  Scenario: The agent starts at boot with nobody signed in
    When the machine restarts
    Then the agent is running
    And nobody is signed in

  Scenario: The running agent has no privilege beyond its own account
    Then the agent's process runs as "beszel" with no capability and no way to gain one
    And the agent's process belongs to no group but its own
    And the account "beszel" cannot read the system journal
    And the agent's process sees no home directory and cannot write to "/usr"
