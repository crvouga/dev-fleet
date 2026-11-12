Feature: Validating the fleet configuration
  devfleet fleet-validate judges a fleet.json without contacting anything. A
  file that breaks a rule is answered with the first rule it breaks: a stable
  code, the JSONPath of the field, what was expected there and what was
  found. With --ansible, the pinned Ansible also reads the inventory the
  definition describes and checks the syntax of every playbook, so a
  definition that validates is one that can converge.

  Background:
    Given a project with no roster
    And the project holds the example fleet configuration

  Scenario: The example validates
    When the operator runs "devfleet fleet-validate --file $PROJECT/fleet.json --json"
    Then it exits with 0
    And in the answer, "ok" is true
    And in the answer, "checks.0.id" is "definition:schema"

  Scenario Outline: An invalid fleet.json is answered with where it breaks a rule
    Given in the project's fleet configuration, "<field>" is <value>
    When the operator runs "devfleet fleet-validate --file $PROJECT/fleet.json --json"
    Then it exits with 1
    And it answers with at least:
      """
      {
        "command": "fleet-validate",
        "ok": false,
        "problem": { "code": "<code>", "path": "<path>", "expected": "<expected>", "actual": "<actual>" }
      }
      """

    Examples:
      | field                     | value         | code                 | path                         | expected                    | actual          |
      | workers.1.network.sshPort | 70000         | DEFINITION_INVALID   | $.workers[1].network.sshPort | a port from 1 to 65535      | 70000           |
      | manager.os                | "linux"       | DEFINITION_INVALID   | $.manager.os                 | \"macOS\"                   | \"linux\"       |
      | workers.1.id              | "worker-one"  | DEFINITION_DUPLICATE | $.workers[1].id              | an id no other machine has  | \"worker-one\"  |
      | canary                    | "worker-nine" | DEFINITION_INVALID   | $.canary                     | the id of a declared worker | \"worker-nine\" |

  Scenario: A file that is not JSON is unreadable, at its root
    Given the project's fleet configuration holds "{ not json"
    When the operator runs "devfleet fleet-validate --file $PROJECT/fleet.json --json"
    Then it exits with 1
    And in the answer, "problem.code" is "DEFINITION_UNREADABLE"
    And in the answer, "problem.path" is "$"

  Rule: With --ansible, the definition drives the pinned Ansible

    Scenario: The inventory names the manager and every worker, and every playbook is syntax-checked
      Given the pinned Ansible accepts everything
      When the operator validates the project's fleet configuration with Ansible
      Then it exits with 0
      And the inventory Ansible listed has the hosts:
        | group   | host        |
        | manager | manager-mac |
        | workers | worker-one  |
        | workers | worker-two  |
      And Ansible checked the syntax of every playbook under "ansible/ubuntu" and "ansible/macos"
      And no command reached another machine

    Scenario: A playbook Ansible cannot parse fails the validation
      Given the pinned Ansible refuses the syntax of "ansible/ubuntu/baseline.yml"
      When the operator validates the project's fleet configuration with Ansible
      Then it exits with 1
      And in the answer, "checks.2.summary" is "DEFINITION_PLAYBOOK_SYNTAX: ansible/ubuntu/baseline.yml"
