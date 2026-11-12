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

    Scenario: Ansible reaches a worker with the options of a direct session, and the package's Ansible configuration
      Given "workers.1.ssh" is removed from the project's fleet configuration
      And the pinned Ansible accepts everything
      When the operator validates the project's fleet configuration with Ansible
      Then it exits with 0
      And the inventory reaches "worker-two" at "worker-two.tail0a1b2c.ts.net"
      And the inventory gives "worker-two" the SSH options:
        | StrictHostKeyChecking=yes        |
        | BatchMode=yes                    |
        | ConnectionAttempts=3             |
        | ServerAliveInterval=15           |
        | HostKeyAlias=devfleet-worker-two |
        | User=dev                         |
        | Port=22                          |
      And the inventory gives "worker-one" the SSH options:
        | StrictHostKeyChecking=yes |
        | ConnectionAttempts=3      |
      And the inventory gives "worker-one" no SSH option "UserKnownHostsFile"
      And every Ansible run used the package's Ansible configuration

  Rule: A worker is reached through an SSH alias, or from its network block

    Scenario: A worker with a network block needs no SSH alias
      Given "workers.1.ssh" is removed from the project's fleet configuration
      When the operator runs "devfleet fleet-validate --file $PROJECT/fleet.json --json"
      Then it exits with 0
      And in the answer, "ok" is true

    Scenario: A worker with neither is answered with its missing alias
      Given "workers.1.ssh" is removed from the project's fleet configuration
      And "workers.1.network" is removed from the project's fleet configuration
      When the operator runs "devfleet fleet-validate --file $PROJECT/fleet.json --json"
      Then it exits with 1
      And it answers with at least:
        """
        {
          "problem": { "code": "DEFINITION_MISSING", "path": "$.workers[1].ssh", "expected": "an SSH host alias, or a network block to connect from", "actual": "nothing" }
        }
        """

  Rule: Worker records an infrastructure tool writes are declared workers
    fleet.json may name a file, or a command, that returns worker records:
    the provider-neutral description of a machine in
    schema/worker-record.schema.json. dev-fleet only reads it.

    Background:
      Given these worker records:
        """
        {
          "version": 1,
          "workers": [
            {
              "id": "rented-one",
              "tailnetName": "rented-one.tail0a1b2c.ts.net",
              "user": "dev",
              "port": 22,
              "hostKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfTheRentedWorker",
              "labels": { "pool": "rented" },
              "billing": { "hourlyRate": 0.5, "currency": "USD" }
            }
          ]
        }
        """

    Scenario: The workers of a record file join the ones fleet.json lists
      Given the project's fleet configuration reads worker records from the file "workers.json"
      When the operator validates the project's fleet configuration
      Then it exits with 0
      And in the answer, "checks.0.summary" contains "a manager and 3 worker(s)"

    Scenario: A record file that is gone holds no record
      The tool that writes it removes it with the last machine.
      Given in the project's fleet configuration, "workerRecords" is [{ "file": "gone.json" }]
      When the operator validates the project's fleet configuration
      Then it exits with 0
      And in the answer, "checks.0.summary" contains "a manager and 2 worker(s)"

    Scenario: The workers a record command prints join them too
      Given the project's fleet configuration reads worker records from the command "infra/print-records --json"
      When the operator validates the project's fleet configuration
      Then it exits with 0
      And in the answer, "checks.0.summary" contains "a manager and 3 worker(s)"
      And the record command "infra/print-records --json" ran in the project directory

    Scenario: A record command that fails leaves the configuration unreadable, at the command
      Given the project's fleet configuration reads worker records from the command "infra/print-records --json"
      And the record command fails
      When the operator validates the project's fleet configuration
      Then it exits with 1
      And in the answer, "problem.code" is "DEFINITION_UNREADABLE"
      And in the answer, "problem.path" is "$.workerRecords[0].command"

    Scenario Outline: An invalid record is answered with the field of the record that breaks a rule
      Given the project's fleet configuration reads worker records from the file "workers.json"
      And in the worker records, "<field>" is <value>
      When the operator validates the project's fleet configuration
      Then it exits with 1
      And it answers with at least:
        """
        {
          "ok": false,
          "problem": { "code": "<code>", "path": "<path>", "expected": "<expected>" }
        }
        """

      Examples:
        | field             | value        | code                 | path                                   | expected                          |
        | workers.0.port    | 0            | DEFINITION_INVALID   | $.workerRecords[0].workers[0].port     | a port from 1 to 65535            |
        | workers.0.hostKey | "not a key"  | DEFINITION_INVALID   | $.workerRecords[0].workers[0].hostKey  | one SSH public key, \"TYPE BASE64\" |
        | workers.0.id      | "worker-one" | DEFINITION_DUPLICATE | $.workerRecords[0].workers[0].id       | an id no other worker has         |
        | workers.0.zone    | "a"          | DEFINITION_UNKNOWN   | $.workerRecords[0].workers[0].zone     | one of id, tailnetName, address, user, port, hostKey, t3Port, labels, billing |
        | version           | 2            | DEFINITION_INVALID   | $.workerRecords[0].version             | 1                                 |

    Scenario: A record without a tailnet name or an address is answered with the missing name
      Given the project's fleet configuration reads worker records from the file "workers.json"
      And "workers.0.tailnetName" is removed from the worker records
      When the operator validates the project's fleet configuration
      Then it exits with 1
      And in the answer, "problem.code" is "DEFINITION_MISSING"
      And in the answer, "problem.path" is "$.workerRecords[0].workers[0].tailnetName"
