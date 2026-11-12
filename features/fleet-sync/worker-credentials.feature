@vault
Feature: Each worker's Vault token is its own
  The manager issues every worker a token under a policy of its own and keeps
  it in a document of its own. A worker's token reads the fleet's shared
  document and its own, never another worker's, and a retired worker's token
  stops working. This runs against a Vault development server, with the Vault
  mise.toml pins.

  Background:
    Given a Vault development server holding the fleet's shared document
    And the manager has issued "worker-one" and "worker-two" their tokens

  Scenario: One worker cannot read another worker's token
    When "worker-one" reads the token document of "worker-two" with its own token
    Then Vault refuses it

  Scenario: A worker reads its own token document and the shared one
    When "worker-one" reads the token document of "worker-one" with its own token
    Then Vault answers it
    And "worker-one" can read the fleet's shared document

  Scenario: After its token is revoked, a retired worker's token no longer authenticates
    When the manager revokes the token of "worker-one"
    Then the earlier token of "worker-one" no longer authenticates
    And the token of "worker-two" still authenticates
