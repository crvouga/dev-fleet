Feature: The CLI proxy is checked off the manager with one line
  A consumer's repository calls the reusable "CLI proxy health" workflow with
  one `uses:` line. It needs no stored secret: the Vault address comes from
  the caller's fleet.json, a short-lived token from GitHub's OIDC token, and
  the checks from the exact dev-fleet release the caller's package.json pins.

  Scenario: The workflow is called with inputs and needs no secret
    Then the CLI proxy health workflow can be called with the inputs:
      | profile      |
      | suite        |
      | model        |
      | check        |
      | max-requests |
      | force-probe  |
      | config       |
      | vault-role   |
      | track-issues |
    And the CLI proxy health workflow needs no secret

  Scenario: The workflow runs the checks of the release the caller pins, against the caller's fleet
    Then the CLI proxy health workflow reads the Vault address from ".secrets.address" of the caller's fleet configuration
    And the CLI proxy health workflow runs the scripts of the "@crvouga/dev-fleet" release the caller's package.json pins
    And the CLI proxy health workflow names no Vault address of its own

  Scenario: The example caller uses the workflow with one line
    Then "cliproxy/docs/health-workflow.example.yml" calls ".github/workflows/cliproxy-health.yml" in one "uses:" line
