# ␠ stands for a space at the start of what a command prints.
Feature: A checkout is synced to its locked toolchain
  A sync brings a checkout's tools and dependencies to what its lock files
  say, through the one shared setup. It never resets, stashes or forces
  anything, and it leaves a receipt only when every step succeeded.

  Rule: A plan says what a sync would do, and runs nothing

    Scenario Outline: The plan of a sync <mode> <says> "<text>"
      When a sync <mode> is planned
      Then the plan <says> "<text>"

      Examples:
        | mode           | says             | text               |
        | without a pull | does not mention | git pull           |
        | with a pull    | mentions         | git pull --ff-only |
        | without a pull | mentions         | bootstrap/setup.ts |

  Rule: A sync changes a checkout only when every step before succeeded

    Background:
      Given a complete checkout at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario Outline: A checkout that is <state> is not pulled, and nothing is installed
      Given the command "git status" prints "<status>"
      And the command "git symbolic-ref" fails
      When the checkout is synced with a pull
      Then the check "sync" fails
      And no command was run with the argument "pull"
      And no "mise" command was run

      Examples:
        | state                      | status          |
        | changed and on no branch   | ␠M private-file |
        | unchanged but on no branch |                 |

    Scenario: A pull that cannot fast-forward stops the sync before anything is installed
      Given the command "git pull" fails
      When the checkout is synced with a pull
      Then the check "sync" fails
      And no "mise" command was run

    Scenario: A setup that fails leaves no receipt of an earlier sync, and its output is not kept
      Given the checkout holds the receipt of an earlier sync
      And the command "mise" fails with the error "secret-token"
      When the checkout is synced without a pull
      Then the check "sync" fails
      And nothing reported contains "secret-token"
      And the checkout holds no file "node_modules/.fleet-sync.json"

    Scenario: A sync runs the shared setup from the locked toolchain and records a receipt
      When the checkout is synced without a pull
      Then the check "sync" passes
      And the first "mise" command run was:
        | mise | exec | --locked | bun | -- | bun | bootstrap/setup.ts | --non-interactive |
      And the receipt "node_modules/.fleet-sync.json" in the checkout has the version 1
