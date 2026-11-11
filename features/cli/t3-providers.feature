Feature: T3 provider instances are reconciled, never taken over
  The fleet declares provider instances and writes them into T3's settings.
  It keeps a record of the instances it owns, and it changes and removes only
  those: everything else in the settings, secrets included, is left as it is
  and never appears in a report.

  Background:
    Given a T3 home
    And every provider the fleet declares here is:
      """
      {
        "driver": "codex",
        "enabled": true,
        "config": { "binaryPath": "/repo/adapter", "homePath": "/home/profile" }
      }
      """

  Rule: A preview writes nothing, and an apply leaves what the fleet does not own

    Background:
      Given T3's settings hold:
        """
        {
          "connect": { "token": "never-report-me" },
          "providerInstances": {
            "other": {
              "driver": "claudeAgent",
              "environment": [{ "secret": { "name": "private" } }]
            }
          }
        }
        """

    Scenario: A preview says what would change and repeats no secret
      When the providers "personal" are previewed
      Then the plan is:
        | id       | action |
        | personal | create |
      And the report does not contain "never-report-me"
      And no ownership record is written

    Scenario: Applying the reviewed plan keeps unrelated settings and secrets
      Given the providers "personal" have been previewed
      When the providers "personal" are applied with the reviewed plan
      Then T3's settings keep "connect" as it was
      And T3's settings keep "providerInstances.other" as it was

    Scenario: Applying again changes nothing and does not rewrite the settings
      Given the providers "personal" have been previewed
      And the providers "personal" have been applied with the reviewed plan
      When the providers "personal" are applied
      Then the report says nothing changed
      And T3's settings file is not rewritten
      And only its owner can read or write T3's settings file

  Rule: Drift is put right, and only instances the fleet owns are removed

    Background:
      Given the providers "personal, retired" have been applied
      And T3's settings were edited to set "providerInstances.personal.enabled" to false
      And T3's settings were edited to set "providerInstances.unrelated" to { "driver": "codex" }

    Scenario: A changed instance is updated and one no longer declared is deleted
      When the providers "personal" are previewed
      Then the plan is:
        | id       | action |
        | personal | update |
        | retired  | delete |

    Scenario: With nothing declared any more, only what the fleet created is removed
      Given the providers "personal" have been applied
      When no providers are applied
      Then T3 is left with exactly these providers:
        """
        { "unrelated": { "driver": "codex" } }
        """

  Rule: An instance that already exists is adopted on request, never overwritten

    Background:
      Given T3's settings hold:
        """
        {
          "providerInstances": {
            "personal": {
              "driver": "codex",
              "enabled": true,
              "config": {
                "binaryPath": "/repo/adapter",
                "homePath": "/home/profile"
              },
              "secret": "keep-private"
            }
          }
        }
        """

    Scenario: The plan calls it a conflict
      When the providers "personal" are previewed
      Then the plan is:
        | id       | action   |
        | personal | conflict |

    Scenario: Applying over it is refused
      When the providers "personal" are applied
      Then it is refused with "without ownership"

    Scenario: Adopting it reveals nothing it holds
      When the provider "personal" is adopted
      Then the report does not contain "keep-private"
      And the ownership record does not contain "keep-private"

    Scenario: Once adopted, it is reconciled like any other
      Given the provider "personal" has been adopted
      When the providers "personal" are applied
      Then it is not refused

  Rule: What cannot be applied safely fails before anything is written

    Scenario: A plan reviewed before the settings changed is stale
      Given the providers "personal" have been previewed
      And T3's settings hold:
        """
        {}
        """
      When the providers "personal" are applied with the reviewed plan
      Then it is refused with "stale"
      And T3's settings file still reads "{}"

    Scenario: A malformed ownership record is refused
      Given T3's settings hold:
        """
        {}
        """
      And the ownership record reads "{bad"
      When no providers are applied
      Then it is refused with "Invalid"

    Scenario: Settings that are a symbolic link are refused and what they link to is left alone
      Given T3's settings are a symbolic link to a file that reads "{}"
      When no providers are applied
      Then it is refused with "symlinks"
      And the file T3's settings link to still reads "{}"

  Rule: One writer at a time, and an interrupted apply can be run again

    Scenario: While another operation holds the lock, an apply is refused
      Given another T3 operation holds the lock
      When no providers are applied
      Then it is refused with "lock"

    Scenario: An apply interrupted after recording what it owns is finished by running it again
      Given an apply was interrupted after recording that the fleet owns "personal"
      And the providers "personal" have been applied
      When the providers "personal" are previewed
      Then the report says nothing changed

  Rule: The t3 commands work against a T3 home of their own, with no proxy and no network

    Background:
      Given a project with no roster
      And the T3 definition "$T3_HOME/empty.json" reads:
        """
        { "version": 1, "instances": {} }
        """

    Scenario: t3-apply --dry-run plans
      When the operator runs "devfleet t3-apply --dry-run --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      Then it exits with 0

    Scenario: t3-apply applies after a dry run
      Given the operator has run "devfleet t3-apply --dry-run --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      When the operator runs "devfleet t3-apply --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      Then it exits with 0

    Scenario: t3-status finds no drift after an apply
      Given the operator has run "devfleet t3-apply --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      When the operator runs "devfleet t3-status --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      Then it exits with 0

    Scenario: t3-cleanup removes what an apply owns
      Given the operator has run "devfleet t3-apply --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      And the operator has run "devfleet t3-status --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      When the operator runs "devfleet t3-cleanup --t3-home $T3_HOME --definition $T3_HOME/empty.json --json"
      Then it exits with 0

  Rule: Reading T3 configuration always ends

    Scenario: A relative path is read without walking past the root
      The check for symbolic links walks up from the file; from a relative
      path it must still stop.
      When T3 configuration is read from the relative path "package.json"
      Then it is found
