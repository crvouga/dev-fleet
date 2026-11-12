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

  Scenario: Every command says when it changes the machine
    Ansible cannot tell what a command did. One that does not say reports a
    change on every run, so a second run is never quiet and drift cannot be
    told from noise.
    When every task of every playbook is read
    Then every command task sets "changed_when" or "creates"

  Scenario: A command that only reads runs in a dry run, or says it verifies a change
    Check mode skips a command unless told otherwise. A read it skips leaves
    nothing for the tasks after it to decide on, so a dry run would fail or
    report what it cannot know. A read that verifies a change a dry run did
    not make is skipped there explicitly.
    When every task of every playbook is read
    Then every command task that changes nothing sets "check_mode" to false or is skipped when "ansible_check_mode"
