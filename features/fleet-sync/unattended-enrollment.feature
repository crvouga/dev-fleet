Feature: A run without a person enrolls a worker only when every fact is verified
  Machines appear without a person present: from a pipeline, a scheduled sync
  or an agent that runs fleet-sync --json. Such a run enrolls a declared
  worker when its pinned host key matched (every session is strict), sudo -n
  works, and exactly one tailnet device matches it, or none when the fleet
  declares a tailnet control plane that joins it during the run. Anything
  ambiguous stops with its existing code; nothing is guessed and nothing
  prompts.

  Background:
    Given the manager has enrolled no worker yet
    And every SSH alias resolves to its own name in the tailnet "example.ts.net"
    And "worker-two" cannot be reached over SSH

  Scenario: A worker on the tailnet with passwordless sudo is enrolled with its device
    Given the tailnet shows these devices:
      | id         | dns                           |
      | nWorkerOne | worker-one.example.ts.net     |
    And "worker-one" answers a fresh SSH session with the home "/home/dev"
    And "worker-one" has passwordless sudo
    When fleet-sync enrolls without a person
    Then the run enrolled:
      | worker-one |
    And the roster binds "worker-one" to the tailnet device "nWorkerOne", with the workspace "/home/dev/.local/share/personal/fleet"

  Scenario: Two devices that match one worker enroll nothing
    Given the tailnet shows these devices:
      | id         | dns                           |
      | nWorkerOne | worker-one.example.ts.net     |
      | nOldOne    | worker-one.example.ts.net     |
    And "worker-one" answers a fresh SSH session with the home "/home/dev"
    And "worker-one" has passwordless sudo
    When fleet-sync enrolls without a person
    Then the run enrolled nobody
    And the run reports "worker-one" with "TAILSCALE_IDENTITY_CONFLICT"

  Scenario: A worker without passwordless sudo is not enrolled, and nothing prompts
    Given the tailnet shows these devices:
      | id         | dns                           |
      | nWorkerOne | worker-one.example.ts.net     |
    And "worker-one" answers a fresh SSH session with the home "/home/dev"
    And "worker-one" asks for a sudo password
    When fleet-sync enrolls without a person
    Then the run enrolled nobody
    And the run reports "worker-one" with "SUDO_AUTHORIZATION_REQUIRED"

  Scenario: A worker not on the tailnet stays out unless the run can join it
    Given the tailnet shows no devices
    And "worker-one" answers a fresh SSH session with the home "/home/dev"
    And "worker-one" has passwordless sudo
    When fleet-sync enrolls without a person
    Then the run enrolled nobody
    And the run reports "worker-one" with "TAILSCALE_ENROLLMENT_REQUIRED"

  Scenario: With a tailnet control plane, a worker not on the tailnet is enrolled to bootstrap over SSH and join
    Given the fleet declares the tailnet control plane:
      """
      { "api": "tailscale", "tag": "tag:fleet-worker" }
      """
    And the tailnet shows no devices
    And "worker-one" answers a fresh SSH session with the home "/home/dev"
    And "worker-one" has passwordless sudo
    When fleet-sync enrolls without a person
    Then the run enrolled:
      | worker-one |
    And the roster lets "worker-one" bootstrap over SSH, with the workspace "/home/dev/.local/share/personal/fleet"

  Scenario: An image that lets only root in gets the declared account first
    Given the tailnet shows these devices:
      | id         | dns                           |
      | nWorkerOne | worker-one.example.ts.net     |
    And "worker-one" refuses the declared account until the account playbook runs, then answers with the home "/home/dev"
    And "worker-one" has passwordless sudo
    And the playbook "ubuntu/worker-account.yml" succeeds
    When fleet-sync enrolls without a person
    Then the playbook "ubuntu/worker-account.yml" was applied with:
      | variable | value      |
      | target   | worker-one |
      | login    | root       |
      | user     | dev        |
    And the run enrolled:
      | worker-one |
    And the run reports "worker-one" with "Created the declared account dev"

  Scenario: The report names the workers a run enrolled, in its text and in its JSON
    Given a fleet-sync report of "worker-one" and "worker-two"
    When the run's enrollment of "worker-one" is added to it
    Then the report lists "worker-one" as enrolled
    And its text says "enrolled   worker-one"
    And it matches "schema/output/fleet-sync.schema.json"
