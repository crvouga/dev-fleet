Feature: How a fleet signs in to GitHub is declared in its fleet configuration
  The optional "github" block of fleet.json says who the manager signs in as,
  whether nodes share a token, what the token must be able to do and which
  repository may be used to verify it. Anything else in it is refused.

  Scenario: Without a block, the manager uses the fleet login and every node shares one token
    When the github block is absent
    Then the manager signs in as "fleet"
    And the credential is "shared"

  Scenario Outline: A block that <case> is refused
    When the github block <block> is read
    Then the configuration is refused, saying "Invalid github block"

    Examples:
      | case                              | block                                          |
      | names an unknown field            | { "token": "x" }                               |
      | names a manager login that is not one | { "manager": { "login": "not a login" } } |
      | names an unknown credential       | { "credential": "app" }                        |
      | names a sandbox that is no repository | { "sandbox": "sandbox" }                   |
      | lists a scope twice               | { "scopes": ["repo", "repo"] }                 |

  Scenario: A Vault fleet that names no location for the GitHub token keeps it beside the proxy key
    Then a Vault fleet reads "github-token" from "fleet/prd" field "GITHUB_TOKEN"
