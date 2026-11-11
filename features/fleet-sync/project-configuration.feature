Feature: A fleet is a project of your own, run with the published package
  A fleet is a fleet.json in a project, and the devfleet CLI run from inside
  it. The CLI names that file for the whole command and for everything the
  command starts in another directory. The package itself says which commit it
  was published from: that is the revision every machine has to run.

  Background:
    Given a project with the directory "machines/notes"

  Rule: The CLI uses the fleet.json of the project it is run from

    Scenario: Outside a project there is no fleet configuration
      When the fleet configuration is looked for from "machines/notes"
      Then no fleet configuration is found

    Scenario Outline: The closest fleet.json at or above "<directory>" is the fleet configuration
      Given the project's "fleet.json" holds:
        """
        {"version":3,"manager":{"id":"manager-mac"}}
        """
      When the fleet configuration is looked for from "<directory>"
      Then the fleet configuration found is the project's "fleet.json"

      Examples:
        | directory      |
        | .              |
        | machines/notes |

    Scenario: The project's fleet.json is named for the command and everything it starts
      fleet-sync re-runs itself from another directory, so the file is named in
      the environment the command passes on.
      Given the project's "fleet.json" holds:
        """
        {"version":3,"manager":{"id":"manager-mac"}}
        """
      And an environment that names nothing
      When devfleet is run in "machines/notes"
      Then devfleet uses the project's "fleet.json"
      And the environment names the project's "fleet.json" as DEVFLEET_CONFIG

    Scenario: Another tool's fleet.json is passed over
      The two files below the project's own are closer to the working
      directory, but neither is a fleet configuration.
      Given the project's "fleet.json" holds:
        """
        {"version":3,"manager":{"id":"manager-mac"}}
        """
      And the project's "machines/notes/fleet.json" holds:
        """
        {"vehicles":[]}
        """
      And the project's "machines/fleet.json" holds:
        """
        not json
        """
      When the fleet configuration is looked for from "machines/notes"
      Then the fleet configuration found is the project's "fleet.json"

    Scenario: A file named in DEVFLEET_CONFIG wins, and a relative one is anchored where the command is run
      It is anchored because fleet-sync re-runs itself from another directory.
      Given the project's "fleet.json" holds:
        """
        {"version":3,"manager":{"id":"manager-mac"}}
        """
      And an environment that names "other/fleet.json" as DEVFLEET_CONFIG
      When devfleet is run in "machines/notes"
      Then devfleet uses the project's "machines/notes/other/fleet.json"
      And the environment names the project's "machines/notes/other/fleet.json" as DEVFLEET_CONFIG

    Scenario: Outside a project nothing is named and the stored configuration is used
      Given an environment that names nothing
      When devfleet is run in "machines/notes"
      Then devfleet uses no project configuration
      And the environment still names nothing

  Rule: A published package knows the commit it is; a checkout does not

    Scenario: This checkout's manifest carries no version and no commit
      When this checkout says what it is
      Then it says at least:
        | version  | 0.0.0-development |
        | revision | null              |

    Scenario: A published package names its version and the commit it was published from
      Given a package whose manifest is:
        """
        {"name":"@scope/dev-fleet","version":"1.4.0","gitHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        """
      When the package says what it is
      Then it says exactly:
        | name     | @scope/dev-fleet                         |
        | version  | 1.4.0                                    |
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
        | issues   | null                                     |

    Scenario Outline: A fork sends its users to its own issue tracker, in either npm form
      Given a package whose manifest is:
        """
        {"name":"@scope/dev-fleet","version":"1.4.0","gitHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bugs":<bugs>}
        """
      When the package says what it is
      Then its issue tracker is "https://git.example.com/scope/dev-fleet/issues"

      Examples:
        | bugs                                                     |
        | "https://git.example.com/scope/dev-fleet/issues"         |
        | {"url":"https://git.example.com/scope/dev-fleet/issues"} |

    Scenario Outline: Anything but an https address is no issue tracker
      Given a package whose manifest is:
        """
        {"name":"@scope/dev-fleet","version":"1.4.0","gitHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bugs":<bugs>}
        """
      When the package says what it is
      Then it names no issue tracker

      Examples:
        | bugs                         |
        | "issues"                     |
        | {"email":"bugs@example.com"} |
        | 7                            |

    Scenario Outline: Anything but a full commit is no revision to converge a fleet to
      Given a package whose manifest is:
        """
        {"name":"@scope/dev-fleet","version":"1.4.0","gitHead":<gitHead>}
        """
      When the package says what it is
      Then it names no revision

      Examples:
        | gitHead                                    |
        | "main"                                     |
        | "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"  |
        | "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" |
        | 7                                          |

    Scenario: A manifest without a commit names no revision
      Given a package whose manifest is:
        """
        {"name":"@scope/dev-fleet","version":"1.4.0"}
        """
      When the package says what it is
      Then it names no revision

  Rule: Code run from a checkout uses the dev-fleet checkout the command is started in

    Scenario: The workspace is the checkout above the working directory
      A dev-fleet checkout, as opposed to any other project, is the one that
      holds the manager run script.
      Given the project's "bootstrap/fleet-manager-run.sh" holds:
        """
        #!/bin/sh
        """
      And an environment that names nothing
      When the settings are resolved in "machines/notes"
      Then the workspace is the project
