@fresh-box @slow
Feature: A fresh Ubuntu machine becomes a worker over SSH
  A machine needs nothing beforehand but an SSH server, an account that can
  use sudo and the manager's key. fleet-sync brings everything else: the
  commit, the operating system packages, the pinned toolchain and the fleet
  configuration. This runs the production bootstrap over a real SSH
  connection against a disposable machine, and only when
  DEVFLEET_TEST_FRESH_BOX is set, because it downloads the worker toolchain.

  Background:
    Given a fresh Ubuntu 26.04 machine with an SSH server and an account that can use sudo
    And the manager reaches it over SSH with its own key and the machine's verified host key

  Scenario: The machine starts with none of the tools dev-fleet needs
    Then the machine had none of these commands when it was created:
      | git              |
      | curl             |
      | python3          |
      | ansible-playbook |
      | mise             |
      | bun              |
      | node             |

  Scenario: The first fleet-sync bootstraps the machine
    When the manager bootstraps the machine at the commit under test
    Then the bootstrap reaches node convergence
    And the machine holds the commit under test, checked out without its history
    And the machine holds the fleet configuration, without the bucket it names
    And the machine runs the mise release mise.toml pins
    And the devfleet launcher is installed on the machine
    And these tools run on the machine at the version mise.toml pins:
      | tool   | command          |
      | bun    | bun --version    |
      | node   | node --version   |
      | python | python3 -V       |
      | uv     | uv --version     |
      | gh     | gh --version     |
      | jq     | jq --version     |
      | vault  | vault version    |
      | codex  | codex --version  |
      | claude | claude --version |
    And these packages are installed at the exact version the Ubuntu policy pins:
      | git             |
      | curl            |
      | ca-certificates |
      | unzip           |
      | xz-utils        |
      | build-essential |
      | python3         |
      | ansible-core    |
    And the machine reports these checks as passed:
      | workstation:configuration   |
      | worker:ubuntu               |
      | worker:sudo                 |
      | worker:package:ansible-core |
      | agent:claude:version        |
      | agent:codex:version         |

  Scenario: An agent's new worktree needs no trust
    Given the manager has bootstrapped the machine
    When an agent creates a worktree with its own mise.toml on the machine
    Then the pinned tools resolve there without anyone trusting it

  Scenario: Bootstrapping the machine again is quick and transfers nothing
    Given the manager has bootstrapped the machine
    When the manager bootstraps the machine again
    Then the bootstrap reaches node convergence
    And the commit was not sent again
    And it took less than 120 seconds
