Feature: T3 offers only the models the proxy serves
  The provider instances are generated from the accounts signed in on the
  proxy. For each of them, every model T3 offers must be one the proxy serves
  for that account, or choosing it fails on first use; and every model the
  fleet requires must be both served and offered.

  Background:
    Given the proxy serves these models:
      | tool  | account          | models                          |
      | codex | dev@example.test | gpt-6.1-sol, gpt-6-luna         |
    And T3 holds the instances of every account the proxy serves
    And T3's catalogue for the driver "codex" is "gpt-6.1-sol, gpt-6-luna"

  Scenario: Every offered model is served
    When the models T3 offers are checked
    Then the check "t3:models" passes

  Scenario: A model removed from the proxy makes the check fail until T3 drops it
    Given the proxy serves these models:
      | tool  | account          | models      |
      | codex | dev@example.test | gpt-6.1-sol |
    When the models T3 offers are checked
    Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
    And the remedy of the check "t3:models" mentions "T3 offers gpt-6-luna, which the proxy does not serve"
    And nothing reported contains "dev@example.test"

  Scenario: A custom model of an instance counts as offered
    Given the instance of "dev@example.test" adds the custom model "gpt-private"
    When the models T3 offers are checked
    Then the check "t3:models" warns with "T3_MODELS_MISMATCH"
    And the remedy of the check "t3:models" mentions "gpt-private"

  Scenario Outline: A required model that is <where> is reported
    Given the fleet requires the model "<model>" for "codex"
    And T3's catalogue for the driver "codex" is "<catalogue>"
    When the models T3 offers are checked
    Then the check "t3:models" <outcome>

    Examples:
      | where                   | model       | catalogue               | outcome                              |
      | served and offered      | gpt-6.1-sol | gpt-6.1-sol, gpt-6-luna | passes                               |
      | not served by the proxy | gpt-7       | gpt-6.1-sol             | warns with "T3_MODELS_MISMATCH"      |
      | served but not offered  | gpt-6-luna  | gpt-6.1-sol             | warns with "T3_MODELS_MISMATCH"      |

  Scenario: A proxy that does not answer leaves the models unverified
    Given the proxy does not answer
    When the models T3 offers are checked
    Then the check "t3:models" warns with "T3_MODELS_UNVERIFIED"
