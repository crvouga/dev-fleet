Feature: The command catalog
  devfleet is one flat list of commands. An operator, or an agent working for
  one, can find every command, read what it does and see whether it changes
  anything, before there is a roster, a checkout or a credential.

  Background:
    Given a project with no roster

  Rule: Discovery and help need no roster and no credentials

    Scenario Outline: "<command>" answers in a project that has nothing yet
      Given devfleet at version "1.2.3"
      When the operator runs "<command>"
      Then it exits with 0
      And it answers with a document

      Examples:
        | command                              |
        | devfleet commands --json             |
        | devfleet fleet-nodes --schema --json |
        | devfleet fleet-repair --list --json  |
        | devfleet --help                      |
        | devfleet help                        |
        | devfleet help t3-apply               |
        | devfleet fleet-node-add --help       |

    Scenario: Every command in the catalog has help that reads nothing and changes nothing
      When the operator asks every command in the catalog for "--help"
      Then each of them exits with 0
      And each of them prints text containing "Usage:"

  Rule: The catalog is flat and says which commands change something

    Scenario: No two commands share a name
      When the command catalog is read
      Then no two commands share a name

    Scenario: Only these commands change something
      When the command catalog is read
      Then the commands that change something are, in order:
        | fleet-sync            |
        | fleet-state --init    |
        | fleet-state --push    |
        | fleet-state --restore |
        | fleet-node-sync       |
        | fleet-repair          |
        | fleet-node-add        |
        | t3-apply              |
        | t3-cleanup            |
        | cliproxy              |

    Scenario: Every command is a fleet-, t3- or cliproxy command, or the catalog itself
      When the command catalog is read
      Then every command is named like one of:
        | fleet-*  |
        | t3-*     |
        | cliproxy |
        | commands |

    Scenario: A misspelt search still finds the command
      When the command catalog is searched for "docter"
      Then it finds the command "fleet-status"

    Scenario: A search within a group stays in that group
      When the command catalog is searched for "ssh" in the group "Reference"
      Then every command it finds is in the group "Reference"

    Scenario: A search for something that is not there finds nothing
      When the command catalog is searched for "zzzzunfindablezzzzz"
      Then it finds no command

  Rule: A command used wrongly is refused without repeating what was typed
    A usage error never echoes the value of an option, which may be a secret
    pasted by mistake, and never quietly authorizes a change.

    Scenario Outline: "<command>" is a usage error
      Given devfleet at version "1.2.3"
      When the operator runs "<command>"
      Then it exits with 2
      And nothing it answers contains "do-not-echo"
      And no roster is written

      Examples:
        | command                                                  |
        | devfleet --unknown-secret=do-not-echo                    |
        | devfleet fleet-node-add --id do-not-echo                 |
        | devfleet fleet-node-add --id a --ssh a --path /a --apply |
        | devfleet fleet-status --all --local                      |
        | devfleet fleet-status --tailnet --workers                |
        | devfleet fleet-status --tailnet --node do-not-echo       |
        | devfleet fleet-status --timeout not-a-number             |
        | devfleet fleet-repair --list --local                     |
        | devfleet fleet-nodes --onboard --schema                  |
        | devfleet t3-apply --import do-not-echo --dry-run         |

  Rule: Run with no command, devfleet shows its help; asked for JSON, the command index

    Background:
      Given devfleet at version "1.2.3", released at "2026-01-02T03:04:05.000Z"

    Scenario: Run with no command, devfleet prints its help
      A release without an issue tracker prints no line about one.
      When the operator runs "devfleet"
      Then it exits with 0
      And it prints what "devfleet --help" prints
      And it prints text containing "Usage: devfleet"
      And it prints text containing "1.2.3 (released 2026-01-02T03:04:05.000Z)"
      And it prints text containing "--json does not make a command read-only"
      But it does not print "Bugs and feature requests"
      And no roster is written

    Scenario: The version names the release and when it was made
      When the operator runs "devfleet --version"
      Then it prints exactly "1.2.3 (released 2026-01-02T03:04:05.000Z)"

    Scenario: A build from source says it is not a release
      Given devfleet at version "0.0.0-development"
      When the operator runs "devfleet --version"
      Then it prints text containing "unreleased source build"

    Scenario: Asked for JSON with no command, devfleet answers with the command index
      When the operator runs "devfleet --json"
      Then it answers what "devfleet commands --json" answers

    Scenario: The command index carries the agent contract and the release
      A release without an issue tracker names none.
      When the operator runs "devfleet commands --json"
      Then in the answer, "releasedAt" is "2026-01-02T03:04:05.000Z"
      And in the answer, "agent.discovery" is "devfleet commands --json"
      And in the answer, "agent.support.issues" is null
      And the index says what each of these commands does when run without a flag:
        | command      | default   |
        | t3-apply     | apply     |
        | fleet-repair | preview   |
        | fleet-status | read-only |
      And the help of every command in the index ends with "--help"
      And no roster is written

  Rule: Bugs and feature requests go to the issue tracker of the package
    An agent in a consumer's project cannot change dev-fleet and must not patch
    what is installed: the contract and the help both send it to the issues.

    Background:
      Given devfleet at version "1.2.3", with its issue tracker at "https://git.example.com/scope/dev-fleet/issues"

    Scenario: The agent contract says where to report and what never to do
      When the operator runs "devfleet commands --json"
      Then in the answer, "agent.support.issues" is "https://git.example.com/scope/dev-fleet/issues"
      And in the answer, "agent.support.report" contains "bug or feature request"
      And in the answer, "agent.support.never" contains "Do not edit the installed package"
      And in the answer, "agent.support.withhold" contains "public"

    Scenario: The help names the issue tracker
      When the operator runs "devfleet --help"
      Then it prints text containing "Bugs and feature requests: https://git.example.com/scope/dev-fleet/issues."

    Scenario: The package that is published names its own tracker
      Then the package names an issue tracker, an "https://" address that ends in "/issues"

  Rule: What is named on the command line wins over the environment

    Scenario: An explicit workspace and roster are used whatever the environment says
      Given the environment sets:
        | PERSONAL_WORKSPACE    | /wrong |
        | PERSONAL_FLEET_CONFIG | /wrong |
      When devfleet is started in the project with "--workspace $PROJECT --config $PROJECT/fleet.json"
      Then it works in "$PROJECT" with the roster "$PROJECT/fleet.json"
