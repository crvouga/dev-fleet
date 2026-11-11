Feature: The manager converges from a fleet-owned checkout of the revision
  The manager converges from a clean checkout of the exact revision, like every
  worker, never from where fleet-sync was started: that is an installed package
  a package manager may remove, or a working tree with uncommitted edits. The
  checkout is made from a repository the manager owns too: the fleet's source
  repository, fetched into the manager's caches.

  Rule: A sync on the manager re-runs itself from that checkout

    Scenario: A checkout that holds the revision supplies it
      Nothing is fetched.
      Given only the checkout "/work" of the fleet's source repository holds revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", with the run script:
        """
        #!/bin/sh
        echo run
        """
      And the run from the checkout answers with exit code 0 and:
        """
        {"version":3,"ok":true}
        """
      When the manager starts "fleet-sync --json" at revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" from "/work"
      Then it starts "sh -c" with that run script and the arguments "fleet-manager-run bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --json"
      And the run is told its repository is "/work"
      And the result is exactly exit code 0 and the report:
        """
        {"version":3,"ok":true}
        """

    Scenario: Run from the installed package, the revision comes from the source repository into a cache the manager owns
      "/project/node_modules/dev-fleet" is not a checkout: it is a directory
      under some project's node_modules.
      Given only a clone of the fleet's source repository holds revision "cccccccccccccccccccccccccccccccccccccccc", with the run script:
        """
        #!/bin/sh
        echo run
        """
      And the run from the checkout answers with exit code 0 and "done"
      When the manager starts "fleet-sync" at revision "cccccccccccccccccccccccccccccccccccccccc" from "/project/node_modules/dev-fleet"
      Then Git cloned the fleet's source repository with "--no-checkout --origin origin" into "source" in the manager's caches
      And the run is told its repository is "source" in the manager's caches
      And it starts "sh -c" with that run script and the arguments "fleet-manager-run cccccccccccccccccccccccccccccccccccccccc"
      And the command exits with 0
      And the command prints "done"

    Scenario: A revision that cannot be fetched is run from nowhere, least of all in place
      Given Git is offline and no directory holds any revision
      And starting a run would fail the scenario
      When the manager starts "fleet-sync" at revision "dddddddddddddddddddddddddddddddddddddddd" from "/project/node_modules/dev-fleet"
      Then there is no run

    Scenario Outline: Outside a test, fleet-sync leaves the place it was started in or stops
      A test never leaves its own process: the same rule as the hand-off from a
      worker.
      Given Git is offline and no directory holds any revision
      And the environment sets "NODE_ENV" to "<environment>"
      When the manager decides where to run "fleet-sync" at revision "dddddddddddddddddddddddddddddddddddddddd", started from "/project/node_modules/dev-fleet"
      Then the answer is "<answer>"

      Examples:
        | environment | answer      |
        | production  | unavailable |
        | test        | here        |

  Rule: A hand-off sends the run script of the revision it asks for

    Scenario: From the installed package, the run script the package ships is sent
      Given an installed package published from revision "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" that ships the run script:
        """
        #!/bin/sh
        echo run
        """
      And Git is offline and no directory holds any revision
      When the run script of revision "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" is looked up from "/package"
      Then it is the run script:
        """
        #!/bin/sh
        echo run
        """

    Scenario: Another revision's run script is never sent in its place
      Given an installed package published from revision "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" that ships the run script:
        """
        #!/bin/sh
        echo run
        """
      And Git is offline and no directory holds any revision
      When the run script of revision "ffffffffffffffffffffffffffffffffffffffff" is looked up from "/package"
      Then there is no run script

    Scenario: A checkout answers from Git, whatever the package holds
      Given a package that names no revision and ships the run script:
        """
        #!/bin/sh
        echo shipped
        """
      And only the checkout "/work" of the fleet's source repository holds revision "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", with the run script:
        """
        #!/bin/sh
        echo run
        """
      When the run script of revision "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" is looked up from "/work"
      Then it is the run script:
        """
        #!/bin/sh
        echo run
        """
