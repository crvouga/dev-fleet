Feature: Converging a worker never asks for a password
  Initial enrollment establishes sudo once. Routine convergence requires
  "sudo -n" and neither prompts for nor stores a password.

  Background:
    Given the roster entry "fixture", with the workspace "/unused"

  Scenario: A worker that already has sudo is neither prompted nor changed
    Given every command on a worker succeeds
    When the privilege of that machine is authorized, with no authorization script
    Then there are no checks
    And 1 command was run
    And every command run has the argument "StrictHostKeyChecking=yes"
    And every command run ends with "sudo -n true"

  Scenario: An unknown host key stays an SSH failure, without a prompt for sudo
    Given every command on a worker fails with "Host key verification failed. PRIVATE_SENTINEL"
    When the privilege of that machine is authorized, with the authorization script "#!/bin/sh"
    Then the first check is "ssh:host-key"
    And the checks do not mention "PRIVATE_SENTINEL"

  Scenario: Missing privilege without an authorization script remains an action for the operator
    Given every command on a worker fails with "sudo: a password is required"
    When the privilege of that machine is authorized, with no authorization script
    Then the first check's summary is "SUDO_AUTHORIZATION_REQUIRED"
