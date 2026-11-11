Feature: Every provider T3 lists is named by one convention
  A provider the fleet manages is "<Provider> CLI Proxy". A login of the
  machine's own is "<Provider> <account email>". Only display names are ever
  written, and only the address is read from a login record, never a token.

  Rule: A managed provider is named as the proxy, any other after its own account

    Background:
      Given these accounts are signed in on this machine, by where each login is kept:
        | driver      | home    | account            |
        | claudeAgent | default | first@example.com  |
        | claudeAgent | other   | second@example.com |
        | codex       | any     | first@example.com  |

    Scenario: Each provider gets its conventional name
      A provider with no readable account gets its name alone, never a guess;
      one of a kind the fleet does not know is left as it is.
      Given T3 lists these providers:
        """
        {
          "personal_claude_proxy": {
            "driver": "claudeAgent",
            "displayName": "Claude (CLI Proxy)"
          },
          "claudeAgent": {
            "driver": "claudeAgent",
            "displayName": "Claude",
            "enabled": true
          },
          "work": {
            "driver": "claudeAgent",
            "displayName": "my other claude",
            "config": { "homePath": "/other" }
          },
          "antigravity": { "driver": "antigravity", "displayName": "Antigravity" },
          "custom": { "driver": "pi", "displayName": "Pi thing" }
        }
        """
      And the fleet manages these providers under these names:
        | id                    | name             |
        | personal_claude_proxy | Claude CLI Proxy |
      When the providers are named by the convention
      Then T3 lists exactly these providers:
        """
        {
          "personal_claude_proxy": {
            "driver": "claudeAgent",
            "displayName": "Claude CLI Proxy"
          },
          "claudeAgent": {
            "driver": "claudeAgent",
            "displayName": "Claude first@example.com",
            "enabled": true
          },
          "work": {
            "driver": "claudeAgent",
            "displayName": "Claude second@example.com",
            "config": { "homePath": "/other" }
          },
          "antigravity": { "driver": "antigravity", "displayName": "AntiGravity" },
          "custom": { "driver": "pi", "displayName": "Pi thing" },
          "codex": { "driver": "codex", "displayName": "Codex first@example.com" }
        }
        """

    Scenario: A default login that is signed in gains an entry
      Given T3 lists no provider
      When the providers are named by the convention
      Then T3 lists exactly these providers:
        """
        {
          "claudeAgent": {
            "driver": "claudeAgent",
            "displayName": "Claude first@example.com"
          },
          "codex": { "driver": "codex", "displayName": "Codex first@example.com" }
        }
        """

    Scenario: Naming a second time changes nothing
      Given T3 lists these providers:
        """
        {
          "claudeAgent": {
            "driver": "claudeAgent",
            "displayName": "Claude first@example.com"
          },
          "codex": { "driver": "codex", "displayName": "Codex first@example.com" }
        }
        """
      When the providers are named by the convention
      Then T3 lists what it listed before

    Scenario: A login already listed under another ID does not get a second entry of the same name
      Given T3 lists these providers:
        """
        { "claudeAgent_2": { "driver": "claudeAgent", "displayName": "Claude" } }
        """
      When the providers are named by the convention
      Then T3 lists the providers "claudeAgent_2, codex", in that order

  Rule: In T3's settings only display names are written

    Background:
      Given a T3 home
      And these accounts are signed in on this machine, by where each login is kept:
        | driver      | home    | account            |
        | claudeAgent | default | first@example.com  |
        | claudeAgent | other   | second@example.com |
        | codex       | any     | first@example.com  |
      And T3's settings hold:
        """
        {
          "theme": "dark",
          "providerInstances": {
            "codex": { "driver": "codex", "displayName": "Codex" }
          }
        }
        """

    Scenario: A check reports a rename and writes nothing
      When the names in T3's settings are checked
      Then it reports exactly:
        """
        { "changed": true }
        """
      And in T3's settings, "providerInstances.codex.displayName" is "Codex"

    Scenario: Conforming renames the provider and keeps the other settings
      When the names in T3's settings are conformed
      Then in T3's settings, "theme" is "dark"
      And in T3's settings, "providerInstances.codex" is { "driver": "codex", "displayName": "Codex first@example.com" }

    Scenario: Conforming again reports no change
      Given the names in T3's settings have been conformed
      When the names in T3's settings are conformed
      Then it reports exactly:
        """
        { "changed": false }
        """

  Rule: An account is read from the client's own login record, never from a token

    Background:
      Given a home directory
      And Claude's login record there names the account "a@example.com"
      And Codex's login record there holds an identity token for "b@example.com"

    Scenario Outline: The account of "<driver>", read from <place>, is <account>
      When the account signed in to "<driver>" is read from <place>
      Then the account found is <account>

      Examples:
        | driver      | place                           | account         |
        | claudeAgent | that home directory             | "a@example.com" |
        | codex       | that home directory             | "b@example.com" |
        | codex       | a directory that does not exist | none            |
        | antigravity | that home directory             | none            |

  Rule: The fleet's check conforms the T3 home it is given

    Background:
      Given a T3 home
      And no account is signed in on the CLI proxy
      And T3's settings hold:
        """
        { "providerInstances": { "x": { "driver": "grok", "displayName": "g" } } }
        """

    Scenario: The check warns while a rename is pending
      When the fleet checks the provider names of the machine "node"
      Then the check comes back as "warn"

    Scenario: Applied, the check passes and the provider is renamed
      When the fleet applies the provider names of the machine "node"
      Then the check comes back as "pass"
      And in T3's settings, "providerInstances.x.displayName" is "Grok"
