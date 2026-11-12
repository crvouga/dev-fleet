Feature: The authentication document is generated where it can be
  docs/authentication.md says where every credential lives and how it reaches
  each node. Its tables of secrets, credential checks and timers are written
  from the code, so a secret, a check or a timer added without the document
  fails here. DEVFLEET_UPDATE_DOCS=1 rewrites them.

  Scenario Outline: The table of <table> is the one the code describes
    When the table "<table>" is generated from the code
    Then it is the table "<table>" in "docs/authentication.md"

    Examples:
      | table   |
      | secrets |
      | checks  |
      | timers  |

  Scenario: The documents no longer contradict the code
    Then "docs/ubuntu-sync.md" does not contain "renders provider configuration from Vault"
    And "cliproxy/README.md" does not contain "No model aliases are configured"
    And "cliproxy/README.md" does not contain "Use plain native clients during a proxy outage"
    And "cliproxy/scripts/checkpoint.py" does not contain "captured while the process is stopped"
    And "docs/ubuntu-sync.md" does not contain "T3 0.1.7"
