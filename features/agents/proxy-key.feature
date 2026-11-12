Feature: Agents keep reaching the proxy while the secrets provider is down
  Every agent launch presents the proxy client key, read from the fleet's
  secrets provider with the node's own access. A node remembers the last key
  the provider gave it, readable by its user alone. The provider stays the
  source: the remembered key is used only when the provider cannot answer, so
  an unreachable Vault or an expired Vault session of one node leaves its
  agents working while the node's Vault checks report the fault.

  Scenario: The key the provider gives is used and remembered
    Given the secrets provider gives the proxy client key "key-one"
    When an agent launches
    Then the launch presents the proxy client key "key-one"
    And the node remembers the proxy client key "key-one" where only its user can read it

  Scenario: A key rotated in the provider is used at the next launch
    Given the node remembers the proxy client key "key-one"
    And the secrets provider gives the proxy client key "key-two"
    When an agent launches
    Then the launch presents the proxy client key "key-two"
    And the node remembers the proxy client key "key-two" where only its user can read it

  Scenario: The remembered key is used while the provider cannot answer
    Given the node remembers the proxy client key "key-one"
    And the secrets provider cannot answer
    When an agent launches
    Then the launch presents the proxy client key "key-one"

  Scenario: A node that never read the key cannot launch without the provider
    Given the secrets provider cannot answer
    When an agent launches
    Then it is refused with "Required secret unavailable: proxy-client-key"
