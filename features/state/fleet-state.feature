Feature: fleet-state shows the fleet state and connects it to a bucket
  `fleet-state` alone is read-only. Each flag is one explicit action on the
  manager's fleet state or its bucket: --init, --import, --export, --example,
  --push and --restore.

  In a command, `~` is the manager's home, `$BUCKET` is a directory that
  stands in for the bucket, and `$EXAMPLE` is the example fleet: the file
  examples/fleet.json without the bucket it names. A stand-in for Litestream
  keeps the bucket in that directory.

  Scenario: With nothing set up the status is read-only and says what to do first
    When the operator runs "fleet-state" on the manager
    Then the command exits 1
    And the report lists exactly these checks:
      | state:bucket     | warn |
      | state:replica    | warn |
      | state:definition | fail |
      | state:roster     | skip |
      | state:enrollment | skip |
    And the report includes:
      """
      {
        "command": "fleet-state",
        "standing": "local-only",
        "bucket": { "configured": false }
      }
      """
    And the output contains "fleet-state --init --bucket"
    And Litestream was never started
    And the manager has no bucket.json

  Rule: A new fleet connects a bucket, stores its configuration and a second manager restores it

    Scenario: An empty bucket is connected; the configuration is the next step
      When the operator runs "fleet-state --init --directory $BUCKET" on manager "a"
      Then the command exits 0
      And the report includes these checks:
        | state:definition | warn |

    Scenario: The configuration is stored and reaches the bucket
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      When the operator runs "fleet-state --import $EXAMPLE" on manager "a"
      Then the command exits 0
      And the report includes:
        """
        { "standing": "in-sync", "ok": true }
        """
      And the report includes these checks:
        | state:bucket     | pass |
        | state:replica    | pass |
        | state:definition | pass |

    Scenario: Another manager, given only where the bucket is, restores the fleet state
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      And the operator ran "fleet-state --import $EXAMPLE" on manager "a"
      When the operator runs "fleet-state --init --directory $BUCKET" on manager "b"
      Then the command exits 0
      And the output contains "Restored the fleet state from the bucket."

    Scenario: The restored configuration is the one the first manager stored
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      And the operator ran "fleet-state --import $EXAMPLE" on manager "a"
      And the operator ran "fleet-state --init --directory $BUCKET" on manager "b"
      When the operator runs "fleet-state --export" on manager "b"
      Then the output is the configuration in the fleet state of manager "a"
      And the report includes:
        """
        { "definition": { "version": 3, "manager": { "id": "manager-mac" } } }
        """

  Rule: --init moves what an existing manager kept in files into the state and seeds the bucket

    Background:
      Given the manager kept the example fleet as its configuration in "~/.config/dev-fleet/fleet.json"
      And the manager kept its roster in "~/.config/personal/fleet.json":
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """
      And the manager kept its enrollment in "~/.local/share/personal/fleet/manager/enrollment.json":
        """
        {"version":1,"id":"manager","approvedRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        """

    Scenario: Until then the status says each document is still read from a file
      When the operator runs "fleet-state" on the manager
      Then the report includes these checks:
        | state:definition | warn |
        | state:roster     | warn |
        | state:enrollment | warn |

    Scenario: --init moves all three and seeds the bucket
      Given the operator ran "fleet-state" on the manager
      When the operator runs "fleet-state --init --directory $BUCKET" on the manager
      Then the command exits 0
      And the output contains "definition, roster, enrollment"
      And the report includes:
        """
        { "standing": "in-sync" }
        """
      And the fleet state of the manager holds the enrollment:
        """
        {"version":1,"id":"manager","approvedRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        """
      And the fleet state of the manager holds the roster:
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """
      And "~/.config/personal/fleet.json" on the manager still holds:
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """

    Scenario: A second --init moves nothing
      Given the operator ran "fleet-state --init --directory $BUCKET" on the manager
      When the operator runs "fleet-state --init" on the manager
      Then the output does not contain "Moved into the fleet state"

  Rule: A bucket that already holds the fleet is never overwritten from earlier files

    Scenario: A second manager's stale enrollment file stays out of the fleet state
      Given the operator ran "fleet-state --init --directory $BUCKET" on manager "a"
      And the operator ran "fleet-state --import $EXAMPLE" on manager "a"
      And manager "b" kept its enrollment in "~/.local/share/personal/fleet/manager/enrollment.json":
        """
        {"version":1,"id":"manager","approvedRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        """
      When the operator runs "fleet-state --init --directory $BUCKET" on manager "b"
      Then the fleet state of manager "b" holds no enrollment
      And the fleet state of manager "b" holds a configuration

  Rule: --restore discards local changes only when told to, and --push uploads them

    Background:
      Given the operator ran "fleet-state --init --directory $BUCKET" on the manager
      And the operator ran "fleet-state --import $EXAMPLE" on the manager
      And "~/edited.json" on the manager holds the example fleet with "worker-two" renamed "worker-renamed"
      And the bucket stopped answering

    Scenario: A change made while the bucket is away is kept and reported
      When the operator runs "fleet-state --import ~/edited.json" on the manager
      Then the command exits 1
      And the report includes:
        """
        { "standing": "unreachable" }
        """

    Scenario: Once the bucket answers, the manager is ahead of it
      Given the operator ran "fleet-state --import ~/edited.json" on the manager
      And the bucket answered again
      When the operator runs "fleet-state" on the manager
      Then the report includes:
        """
        { "standing": "local-ahead" }
        """

    Scenario: --restore refuses to discard what the bucket does not hold
      Given the operator ran "fleet-state --import ~/edited.json" on the manager
      And the bucket answered again
      When the operator runs "fleet-state --restore" on the manager
      Then it is refused with "repeat with --yes"

    Scenario: --push uploads it
      Given the operator ran "fleet-state --import ~/edited.json" on the manager
      And the bucket answered again
      And the operator tried "fleet-state --restore" on the manager
      When the operator runs "fleet-state --push" on the manager
      Then the report includes:
        """
        { "standing": "in-sync" }
        """
      And the command exits 0

    Scenario: After a push, --restore has nothing to discard
      Given the operator ran "fleet-state --import ~/edited.json" on the manager
      And the bucket answered again
      And the operator ran "fleet-state --push" on the manager
      When the operator runs "fleet-state --restore" on the manager
      Then the command exits 0
      And the configuration in the fleet state of the manager contains "worker-renamed"

  Rule: A command that cannot be carried out is refused, naming the flag, and stores nothing

    Scenario Outline: Refused: <command>
      Given "~/broken.json" on the manager holds:
        """
        {"version":3}
        """
      When the operator runs "<command>" on the manager
      Then it is refused with "<message>"
      And the fleet state of the manager holds no configuration

      Examples:
        | command                                                       | message                      |
        | fleet-state --import ~/broken.json                            | Invalid fleet definition at  |
        | fleet-state --import ~/missing.json                           | readable JSON file           |
        | fleet-state --export                                          | holds no fleet configuration |
        | fleet-state --restore                                         | No bucket is configured      |
        | fleet-state --init --push                                     | Choose one of                |
        | fleet-state --bucket fleet-state                              | belong to --init             |
        | fleet-state --init --endpoint https://s3.example.com          | need --bucket                |
        | fleet-state --init --bucket fleet-state --directory /tmp/fleet | not both                     |

  Rule: The command is registered, documented and read-only without a flag

    Scenario: Its help names every action
      When devfleet is started with "fleet-state --help"
      Then the command exits 0
      And the output contains each of:
        | --init    |
        | --bucket  |
        | --push    |
        | --restore |
        | --import  |

    Scenario: Started with no flag it reports on the state directory it was given
      The process has its own empty state directory and no bucket.
      Given the process runs on a manager with an empty fleet state
      When devfleet is started with "fleet-state --json"
      Then the report includes:
        """
        { "command": "fleet-state", "standing": "local-only" }
        """
      And the report names the state directory of the manager as its root

  Rule: The example printed to start a project from is a valid configuration without credentials

    Scenario: --example prints the packaged example and touches nothing
      When the operator runs "fleet-state --example" on the manager
      Then the command exits 0
      And the output is the configuration in the report
      And the configuration in the report has "$schema" set to "./node_modules/@crvouga/dev-fleet/schema/fleet.schema.json"
      And the configuration in the report is valid and names the bucket "my-fleet-state"
      And the output does not contain "accessKey"
      And Litestream was never started
      And the manager has no state directory
