Feature: fleet-node-sync converges the machine it is run on
  One local convergence: locked tools, the launcher, the Codex proxy profile,
  then the T3 providers. It applies when it is run; --dry-run previews.

  Rule: The command is in the catalog and says how to preview

    Background:
      Given devfleet runs from "/not-a-real-checkout" with the roster "/not-a-real-roster"

    Scenario: Its help names --dry-run
      When the operator runs "devfleet fleet-node-sync --help"
      Then it exits with 0
      And it prints text containing "--dry-run"

    Scenario: The command index lists it
      When the operator runs "devfleet commands --json"
      Then the answer contains "fleet-node-sync"

  Rule: Nothing changes in a dry run, or under a name that is not a node ID

    Background:
      Given devfleet runs from "/not-a-real-checkout" with the roster "/not-a-real-roster"

    Scenario: A dry run resolves the revision and runs nothing else
      Given every command on this machine prints "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When the operator runs "devfleet fleet-node-sync --id dev-linux --dry-run"
      Then it exits with 0
      And it answers with at least:
        """
        {
          "applied": false,
          "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "node": "dev-linux",
          "profile": "proxy"
        }
        """
      And exactly these commands were run:
        | git rev-parse --verify HEAD |

    Scenario: A name that is not a node ID is refused before any tool runs
      Given no command may run on this machine
      When the operator runs "devfleet fleet-node-sync --id ../bad"
      Then it is refused
      And no command was run

  @posix
  Rule: A sync applies tools, launcher, profile and T3 providers, then records the revision

    Background:
      Given a checkout at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", with that revision unpacked under "node_modules/.fleet-revisions"
      And the revision carries the T3 definition the package ships
      And applying a profile in the revision answers:
        """
        {
          "ok": true,
          "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "fingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
        """
      And these accounts are signed in on the CLI proxy:
        | tool  | email         | prefix              | models |
        | codex | a@example.com | codex-a@example.com | gpt-x  |

    Scenario: A sync gives T3 the providers of the revision and records the revision
      When the operator runs "devfleet fleet-node-sync --id node --t3-home $T3_HOME"
      Then it exits with 0
      And in T3's settings, "providerInstances.personal_codex_a_example_com.config.binaryPath" contains "$CHECKOUT/node_modules/.fleet-revisions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And the receipt of the checkout names the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: A sync can be repeated
      Given the operator has run "devfleet fleet-node-sync --id node --t3-home $T3_HOME"
      When the operator runs "devfleet fleet-node-sync --id node --t3-home $T3_HOME"
      Then it exits with 0

    Scenario: A T3 conflict is reported as partial progress and the revision is not recorded
      Given T3's settings hold:
        """
        { "providerInstances": { "personal_grok_proxy": { "driver": "grok" } } }
        """
      When the operator runs "devfleet fleet-node-sync --id node --t3-home $T3_HOME"
      Then it exits with 1
      And it answers with at least:
        """
        { "applied": true, "stage": "t3" }
        """
      And the checkout has no receipt
