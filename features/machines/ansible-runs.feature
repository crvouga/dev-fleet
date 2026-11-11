Feature: Playbooks run with a pinned Ansible and private variables
  Every change to a machine is a playbook. The variables of a run can hold
  credentials, so they reach Ansible in a file only its user can read, kept
  for the length of the run: never in an argument, on standard input or in a
  log.

  Rule: Variables are a private, short-lived file

    Scenario: Variables stay out of the arguments and standard input, and are removed after the run
      Given a private run directory
      When the playbook "fixture.yml" is run with the variables:
        """
        {"token":"PRIVATE_SENTINEL"}
        """
      Then the last argument of Ansible was "@" and the path of a variables file
      And no command contains "PRIVATE_SENTINEL"
      And Ansible was given nothing on standard input
      And while Ansible ran, the variables file had the mode "600"
      And while Ansible ran, the directory of the variables file had the mode "700"
      And while Ansible ran, the variables file held the "token" "PRIVATE_SENTINEL"
      And the variables file was in a directory of its own in the run directory
      And the variables file is gone

    Scenario: A run that fails or is interrupted leaves no credential behind
      Given a private run directory
      And Ansible is interrupted with the error "fixture failure"
      When the playbook "fixture.yml" is run with the variables:
        """
        {}
        """
      Then it is refused with "fixture failure"
      And the directory of the variables file is gone

    Scenario: Variables are kept in the private fleet state on disk, not in /tmp
      A worker's /tmp is held in memory, with a quota for each user that agent
      caches can use up. The baseline that bounds it has to run even then.
      Then the variables of a machine whose home is "/home/fixture" are kept in "/home/fixture/.local/state/personal/fleet/run"

  Rule: The same Ansible on every run

    Scenario Outline: The <machine> runs <which Ansible>
      A worker has the exact package its policy pins. The manager runs the
      locked project in the package's "ansible" directory, in an environment
      of its own: never an "ansible-playbook" that happens to be on PATH.
      Then on "<platform>", with the package at "/fleet/checkout", a playbook is run with "<command>"

      Examples:
        | machine | which Ansible              | platform | command                                                                               |
        | worker  | its pinned package         | linux    | ansible-playbook                                                                      |
        | manager | the locked Ansible project | darwin   | uv run --project /fleet/checkout/ansible --locked --isolated --quiet ansible-playbook |
