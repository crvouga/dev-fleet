Feature: The public dashboard is offline without its tunnel credential, and that is only a warning
  A Cloudflare connector publishes the dashboard, started from a token in the
  fleet's secrets. A manager whose Vault session cannot read the token still
  runs the private hub.

  Scenario: A tunnel credential that cannot be read is absent
    Given every command fails saying permission denied
    When the tunnel credential is read from the fleet's secrets
    Then there is no tunnel credential

  Scenario: A missing tunnel credential is a warning that names the manager's Vault session
    When the public endpoint is reported without its tunnel credential
    Then the check warns
    And the remedy of the check contains "manager's Vault session"
    But the remedy of the check does not contain "beszel-hub-read"
