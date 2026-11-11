Feature: Playbooks survive YAML and a move of the package

  Scenario: Assertions stay strings after YAML parsing
    A condition containing a colon and a space becomes a mapping unless it is
    quoted, and Ansible then evaluates something else.
    When every assertion of every playbook is read
    Then every condition is a string

  Scenario: A colon inside an unquoted assertion is caught
    Given a playbook that asserts:
      """
      - ansible.builtin.assert:
          that:
            - value.startswith('managed: marker')
      """
    When its assertions are read
    Then reading them fails with "must be strings"

  Scenario: An ownership check compares the marker, never a path
    A check that names the package directory rejects every machine installed
    before a move.
    When every ownership marker a playbook compares is read
    Then no marker is followed by a path
