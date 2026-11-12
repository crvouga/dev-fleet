Feature: A person does only a few, written-down steps on the manager
  Setting up or rebuilding the manager is one command, fleet-sync, plus the
  steps only a person can take: an identity, an approval or an administrator
  password. They are written down in docs/manager-setup.md, each with the
  check fleet-sync verifies it with, and the list does not grow unnoticed.

  Scenario: The manager needs exactly these human steps
    When the human steps of docs/manager-setup.md are read
    Then they are verified by these checks, in order:
      | manager:docker      |
      | tailscale:discovery |
      | state:bucket        |
      | auth:vault          |
      | manager:power       |
    And every check that verifies one is a check fleet-sync reports

  Scenario: The manager playbook needs no administrator after the one grant
    fleet-sync applies it on every run, unattended: no play becomes root, and
    what needs root runs through sudo -n, which the one grant allows for
    exactly these commands (ansible/macos/manager-privilege.yml).
    When the playbook "ansible/macos/manager.yml" is read
    Then no play of it becomes another user
    And it changes the power settings only through "sudo -n"
    And everything it runs through sudo is one of:
      | -l /usr/bin/pmset                   |
      | /usr/bin/pmset -c                   |
      | /usr/sbin/systemsetup -getusingnetworktime |
