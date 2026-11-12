Feature: Every machine's T3 holds the declared profile
  Beyond the provider instances, fleet.json can declare top-level T3
  settings under t3.profile: tool servers, projects, selected preferences.
  Each declared key converges on every machine. A key nobody declared is the
  machine's own. A key changed on the machine since dev-fleet last wrote it is
  reported, never overwritten.

  Background:
    Given a T3 home whose settings hold:
      """
      { "fontSize": 14, "providerInstances": { "mine": { "driver": "codex" } } }
      """

  Scenario: A tool server declared once reaches T3, and a setting of the user survives
    Given the fleet declares the T3 profile:
      """
      { "mcpServers": { "docs": { "command": "docs-server" } } }
      """
    When the profile is applied
    Then the check "t3:profile" passes
    And T3's settings hold:
      """
      {
        "fontSize": 14,
        "mcpServers": { "docs": { "command": "docs-server" } },
        "providerInstances": { "mine": { "driver": "codex" } }
      }
      """

  Scenario: Applying the same profile again changes nothing
    Given the fleet declares the T3 profile:
      """
      { "mcpServers": { "docs": { "command": "docs-server" } } }
      """
    And the profile has been applied
    When the profile is applied
    Then the profile plan is:
      | key        | action    |
      | mcpServers | unchanged |
    And T3's settings file was not rewritten

  Scenario: A declared change replaces what dev-fleet wrote before
    Given the fleet declares the T3 profile:
      """
      { "mcpServers": { "docs": { "command": "docs-server" } } }
      """
    And the profile has been applied
    And the fleet declares the T3 profile:
      """
      { "mcpServers": { "docs": { "command": "docs-server-2" } } }
      """
    When the profile is applied
    Then the profile plan is:
      | key        | action |
      | mcpServers | update |
    And T3's setting "mcpServers" is:
      """
      { "docs": { "command": "docs-server-2" } }
      """

  Scenario: A managed setting edited on the machine is reported, not overwritten
    Given the fleet declares the T3 profile:
      """
      { "fontSize": 16 }
      """
    When the profile is applied
    Then the check "t3:profile" warns with "T3_PROFILE_CONFLICT"
    And the remedy of the check "t3:profile" mentions "fontSize"
    And T3's setting "fontSize" is:
      """
      14
      """

  Scenario: A setting the user changed after dev-fleet wrote it is kept
    Given the fleet declares the T3 profile:
      """
      { "theme": "dark" }
      """
    And the profile has been applied
    And T3's setting "theme" was changed on the machine to "light"
    And the fleet declares the T3 profile:
      """
      { "theme": "solarized" }
      """
    When the profile is applied
    Then the check "t3:profile" warns with "T3_PROFILE_CONFLICT"
    And T3's setting "theme" is:
      """
      "light"
      """

  Rule: A key the fleet stops declaring is removed only when nobody changed it

    Background:
      Given the fleet declares the T3 profile:
        """
        { "theme": "dark", "wordWrap": true }
        """
      And the profile has been applied
      And T3's setting "wordWrap" was changed on the machine to "false"
      And the fleet declares the T3 profile:
        """
        {}
        """

    Scenario: An undeclared key is removed, or left to the machine
      When the profile is applied
      Then the profile plan is:
        | key      | action  |
        | theme    | delete  |
        | wordWrap | release |
      And T3's settings have no "theme"
      And T3's setting "wordWrap" is:
        """
        false
        """

  Scenario: A preview names the keys and what happens to them, never a value
    A tool server's settings can carry a credential.
    Given the fleet declares the T3 profile:
      """
      { "mcpServers": { "private": { "env": { "TOKEN": "PRIVATE_SENTINEL" } } } }
      """
    When the profile is previewed
    Then the check "t3:profile" warns with "T3_PROFILE_PENDING"
    And the remedy of the check "t3:profile" mentions "mcpServers (create)"
    And nothing reported contains "PRIVATE_SENTINEL"
    And T3's settings have no "mcpServers"

  Rule: T3 writes the same file, so a write waits for a quiet moment

    Background:
      Given the fleet declares the T3 profile:
        """
        { "theme": "dark" }
        """

    Scenario: A write T3 interrupts once is planned again and lands
      Given T3 rewrites its settings while dev-fleet merges, 1 time
      When the profile is applied
      Then the check "t3:profile" passes
      And T3's setting "theme" is:
        """
        "dark"
        """
      And T3's setting "lastOpened" is:
        """
        1
        """

    Scenario: A file T3 keeps rewriting is reported busy after three tries
      Given T3 rewrites its settings while dev-fleet merges, 5 times
      When the profile is applied
      Then the check "t3:profile" fails with "T3_SETTINGS_BUSY"
      And T3's settings have no "theme"

  Scenario Outline: A profile that names <key> is <verdict>
    When a fleet configuration with the T3 profile <profile> is read
    Then the configuration is <verdict>

    Examples:
      | key                    | profile                              | verdict  |
      | a tool server          | { "mcpServers": {} }                 | accepted |
      | the provider instances | { "providerInstances": {} }          | refused  |
      | a malformed key        | { "../escape": 1 }                   | refused  |
