Feature: What a node's GitHub token can do, and for how long
  Being signed in is not enough: an agent fails mid-task when the token lacks
  a permission, is about to expire, has spent its rate limit or is not
  authorised for an organisation's single sign-on. One request to GitHub
  answers the scopes, the expiry and the rate limit; nothing it prints is
  kept.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"
    And "worker-one" is signed in with "TOKEN_A_PRIVATE_0001"
    And the store holds "TOKEN_A_PRIVATE_0001" as "github-token"
    And it is "2026-11-11T12:00:00Z"

  Rule: The token holds the permissions the fleet declares

    Scenario: A token without the workflow scope fails, naming it
      Given the fleet's github block is:
        """
        { "scopes": ["repo", "workflow"] }
        """
      And GitHub answers with the header "X-Oauth-Scopes" set to "repo, read:org"
      When the GitHub checks run on "worker-one"
      Then the check "github:permissions" fails
      And the check "github:permissions" says "GITHUB_PERMISSION_MISSING: workflow"
      And nothing reported contains "TOKEN_A_PRIVATE_0001"

    Scenario: A scope is held when a broader scope includes it
      Given the fleet's github block is:
        """
        { "scopes": ["public_repo", "read:packages", "read:org"] }
        """
      And GitHub answers with the header "X-Oauth-Scopes" set to "repo, write:packages, admin:org"
      When the GitHub checks run on "worker-one"
      Then the check "github:permissions" passes

    Scenario: A repository the token cannot push to fails, naming it
      Given the fleet's github block is:
        """
        { "repositories": ["example-org/app", "example-org/infra"] }
        """
      And the token can push to "example-org/app"
      When the GitHub checks run on "worker-one"
      Then the check "github:permissions" fails
      And the check "github:permissions" says "GITHUB_PERMISSION_MISSING: push to example-org/infra"

    Scenario: A fine-grained token, which reports no scopes, warns rather than passes
      Given the fleet's github block is:
        """
        { "scopes": ["workflow"] }
        """
      When the GitHub checks run on "worker-one"
      Then the check "github:permissions" warns
      And the check "github:permissions" says "GITHUB_SCOPES_NOT_OBSERVABLE"

    Scenario: A fleet that declares no permissions is not measured against any
      When the GitHub checks run on "worker-one"
      Then the check "github:permissions" is skipped

  Rule: A token warns two weeks before it expires and fails three days before

    Scenario Outline: A token that expires at <expiry> <verdict>
      Given GitHub answers with the header "GitHub-Authentication-Token-Expiration" set to "<expiry>"
      When the GitHub checks run on "worker-one"
      Then the check "github:expiry" <verdict>
      And the check "github:expiry" says "<summary>"

      Examples:
        | expiry                   | verdict | summary                                                       |
        | 2026-12-31 00:00:00 UTC  | passes  | The token expires at 2026-12-31T00:00:00.000Z.                |
        | 2026-11-20 12:00:00 UTC  | warns   | GITHUB_TOKEN_EXPIRING_SOON: the token expires at 2026-11-20T12:00:00.000Z. |
        | 2026-11-13 20:00:00 -0800 | fails  | GITHUB_TOKEN_EXPIRING: the token expires at 2026-11-14T04:00:00.000Z. |

    Scenario: A token without an expiry date passes
      When the GitHub checks run on "worker-one"
      Then the check "github:expiry" passes

  Rule: A low rate limit warns, with the time it resets

    Scenario Outline: <remaining> of 5000 requests left <verdict>
      Given GitHub answers with the header "X-Ratelimit-Limit" set to "5000"
      And GitHub answers with the header "X-Ratelimit-Remaining" set to "<remaining>"
      And GitHub answers with the header "X-Ratelimit-Reset" set to "1794441600"
      When the GitHub checks run on "worker-one"
      Then the check "github:rate-limit" <verdict>
      And the check "github:rate-limit" says "<summary>"

      Examples:
        | remaining | verdict | summary                                                                             |
        | 250       | warns   | GITHUB_RATE_LIMIT_LOW: 250 of 5000 requests (5 %) remain until 2026-11-12T00:00:00.000Z. |
        | 2500      | passes  | 2500 of 5000 requests (50 %) remain until 2026-11-12T00:00:00.000Z.                 |

  Rule: Single sign-on must have authorised the token for every declared organisation

    Scenario Outline: An organisation where the login is <membership> <verdict>
      Given the fleet's github block is:
        """
        { "organizations": ["example-org"] }
        """
      And in "example-org" the fleet login is <membership>
      When the GitHub checks run on "worker-one"
      Then the check "github:org-access" <verdict>
      And the check "github:org-access" says "<summary>"

      Examples:
        | membership              | verdict | summary                                         |
        | an active member        | passes  | active member of every declared organisation    |
        | awaiting single sign-on | fails   | GITHUB_SSO_AUTHORIZATION_REQUIRED: example-org  |
        | not a member            | fails   | GITHUB_ORG_MEMBERSHIP_MISSING: example-org      |
