Feature: What a command prints with --json is published, and checked against what it prints
  An agent parses dev-fleet's output by its published schema, not by
  guesswork. Each schema under schema/output is checked here against what the
  command really prints, and every check ID the code can report is listed in
  schema/check-ids.json, generated from the code: what it means, whether it
  can block readiness, and what repairs it.

  Rule: Each command's output matches its schema

    Scenario: A fleet-sync report is version 3
      When fleet-sync stops before it reaches a machine
      Then what it prints matches "schema/output/fleet-sync.schema.json"

    Scenario: A fleet-sync report that says it is version 1 does not match
      Given a fleet-sync report that says it is version 1
      Then it does not match "schema/output/fleet-sync.schema.json"

    Scenario: A fleet-status report is a version 1 diagnostic report
      When fleet-status checks this manager only, where every command succeeds
      Then what it prints matches "schema/output/report.schema.json"

    Scenario: A fleet-repair preview is a version 1 diagnostic report
      When fleet-repair previews the repairs of this manager only, where every command succeeds
      Then what it prints matches "schema/output/report.schema.json"

    Scenario: A fleet-state report is a version 1 diagnostic report
      When fleet-state checks a fleet state whose bucket cannot be reached
      Then what it prints matches "schema/output/report.schema.json"

    Scenario: fleet-state --example prints a fleet configuration, not a report
      When fleet-state prints the example configuration
      Then what it prints matches "schema/output/fleet-state-definition.schema.json"
      And it does not match "schema/output/report.schema.json"

    Scenario Outline: fleet-sync --schedule <action> is a version 2 schedule report, not a fleet-sync report
      When the manager schedule is asked to <action>
      Then what it prints matches "schema/output/fleet-sync-schedule.schema.json"
      And it does not match "schema/output/fleet-sync.schema.json"

      Examples:
        | action                       |
        | report its status            |
        | pause, without authorization |

    Scenario: fleet-report's output matches its schema
      When fleet-report reads a history of two runs
      Then what it prints matches "schema/output/fleet-report.schema.json"

    Scenario: A refused command prints an error document
      When a command is refused as a usage error
      Then what it prints matches "schema/output/error.schema.json"

  Rule: The check-ID registry is generated from the code

    Scenario: The published registry is the one the code generates
      When schema/check-ids.json is read
      Then it is the registry the code generates
      And it matches "schema/check-ids.schema.json"

    Scenario: Every check the code reports has a meaning, and every meaning a check
      When the registry is generated from the code
      Then every check ID the code reports has a meaning
      And no meaning is left without a check
      And every check has an owner in src/check-owners.ts

    Scenario Outline: A check ID is found in the form the code writes it: <form>
      When the check IDs written in this source are listed:
        """
        <source>
        """
      Then they are "<ids>"

      Examples:
        | form                             | source                                                   | ids                         |
        | the id of a check                | return { id: 'ssh:auth', status: 'pass' };               | ssh:auth                    |
        | an id with a fallback            | id: given ?? 'ssh:session',                              | ssh:session                 |
        | a variable a check takes         | const id = `agent:${agent.name}:version`;                | agent:*:version             |
        | the argument of a check builder  | notApplicable('worker:docker-run', reason)               | worker:docker-run           |
        | an attempt                       | attempt('ssh:probe', run)                                | ssh:probe                   |
        | a check without a namespace      | return { id: 'dependencies', status: 'pass' };           | dependencies                |
        | a string that names no check     | import { readFile } from 'node:fs'; recipe('aws');       |                             |
        | an id that is not a check's      | services.push({ id: 'railway', command: ['railway'] });  |                             |

    Scenario: A shell script's check is found in the JSON it prints
      When the check IDs written in this shell script are listed:
        """
        printf '{"version":1,"checks":[{"id":"bootstrap:%s","status":"fail"}]}\n' "$phase"
        """
      Then they are "bootstrap:*"

    Scenario Outline: The registry lists <id> as <severity>, repaired by <repair>
      When schema/check-ids.json is read
      Then it lists "<id>" as <severity>, repaired by "<repair>"

      Examples:
        | id                         | severity | repair       |
        | manager:release            | required | a person     |
        | manager:updates            | advisory | a person     |
        | manager:disk               | required | a person     |
        | manager:container-watchdog | required | a person     |
        | worker:clock               | required | a person     |
        | worker:capacity:disk       | required | disk         |
        | worker:service-recovery    | required | recovery     |
        | auth:github                | required | login:github |
        | auth:grok                  | advisory | a person     |
        | worker:public-reachability | advisory | a person     |
        | bootstrap:prerequisites    | required | a person     |
        | state:roster               | required | state        |
        | tool:*                     | required | workspace    |

    Scenario: A name the code fills in from a list it holds is listed name by name
      When schema/check-ids.json is read
      Then it lists each of:
        | bootstrap:lock                   |
        | bootstrap:prerequisites          |
        | worker:capacity:inodes           |
        | worker:service:tailscaled        |
        | worker:package:git               |
        | auth:vault                       |
        | auth:railway                     |
        | agent:claude:version             |
        | agent:claude:session             |
        | provider:claude:inference        |
        | repair:workspace                 |
        | state:roster                     |
        | notify:ntfy                      |
        | sync:mise.lock                   |
      And the only names left as "*" are the ones taken at run time:
        | agent:*:*:*               |
        | agent:*:account-*:session |
        | agent:*:removed-*:session |
        | fleet:enrollment:*        |
        | proxy:*                   |
        | proxy:account:*           |
        | tool:*                    |

    Scenario: An advisory check is never written as a failure that counts
      When schema/check-ids.json is read
      Then every advisory check the code writes by name fails only where it says it is not required

  Rule: The agent guide points at the schemas and the registry

    Scenario: The agent guide names each schema and the registry, and the real report versions
      Then the agent guide names, for its output:
        | schema/output/report.schema.json                 |
        | schema/output/fleet-sync.schema.json             |
        | schema/output/fleet-sync-schedule.schema.json    |
        | schema/output/fleet-state-definition.schema.json |
        | schema/output/fleet-report.schema.json           |
        | schema/output/error.schema.json                  |
        | schema/check-ids.json                            |
        | severity                                         |
        | repair                                           |
      And the agent guide does not say every report is version 1
