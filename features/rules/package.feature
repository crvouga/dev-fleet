Feature: The published package is the whole CLI and nothing else
  `npx devfleet` runs what `npm pack` ships: a file the CLI reads at run time
  but the archive omits only fails once it is published.

  Scenario: The package carries everything the CLI reads
    When the package is packed
    Then it contains:
      | bin/devfleet.mjs               |
      | src/cli/cli.ts                 |
      | src/package-info.ts            |
      | bootstrap/fleet-manager-run.sh |
      | ansible/ubuntu/baseline.yml    |
      | ansible/pyproject.toml         |
      | ansible/uv.lock                |
      | cliproxy/scripts/cli.py        |
      | examples/fleet.json            |
      | schema/fleet.schema.json       |
      | schema/check-ids.json          |
      | schema/output/fleet-sync.schema.json |
      | mise.toml                      |
      | mise.lock                      |

  Scenario: The manager's schedule runs a file the package ships
    The schedule installs this package, at its exact version, into the
    manager's runtime and runs the entry point its manifest declares.
    When the package is packed
    Then the file the manager's schedule runs, once the package is installed, is one it contains

  Scenario: The package carries the documents an agent sets a fleet up from
    An agent in a project that uses dev-fleet reads them from node_modules,
    at the version the project pins, without fetching anything.
    When the package is packed
    Then it contains:
      | llms.txt               |
      | README.md              |
      | docs/consumer-setup.md |
      | docs/state.md          |

  Scenario: The package is a command and declares no library entry point
    Nothing under src/ is a supported import: a consumer that imported it
    would break on any release, and nobody would know before it upgraded.
    Then the package manifest declares the command "devfleet"
    And the package manifest declares none of these fields:
      | main    |
      | module  |
      | exports |
      | types   |
      | typings |

  Scenario: The package carries no tests
    When the package is packed
    Then it contains no test file, no test directory and no feature

  Scenario: The launcher starts the CLI through Bun and reports the manifest version
    When "node bin/devfleet.mjs --version" is run in the checkout
    Then it prints "0.0.0-development (unreleased source build)"
