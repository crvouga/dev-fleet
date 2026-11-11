Feature: Visitors of the dashboard are signed in as a read-only viewer
  The hub signs every visitor in as one account, so the dashboard needs no
  login. The manager makes sure that account exists and is read-only: an
  account with any other role is demoted, not trusted. Its password is random,
  never stored or printed, and nobody needs it to sign in.

  Background:
    Given the fleet configuration names the viewer account "public-viewer@example.com"

  Scenario: A hub without the viewer gets one, read-only, whose password is not reported
    Given a hub that accepts the fleet admin login and has no viewer account
    When the viewer is ensured with the admin login "fleet@example.test" and the password "fleet-password"
    Then the check passes
    And the hub was asked to create a user with:
      | email    | public-viewer@example.com |
      | role     | readonly                  |
      | verified | true                      |
    And the check does not contain the password that user was created with

  Scenario: A viewer that is already read-only is left alone
    Given a hub that accepts the fleet admin login and has the viewer account "abcdefghijklmno" with the role "readonly"
    When the viewer is ensured with the admin login "fleet@example.test" and the password "fleet-password"
    Then the check passes
    And the hub was not asked to change a user

  Scenario: A viewer with a stronger role is demoted
    Given a hub that accepts the fleet admin login and has the viewer account "abcdefghijklmno" with the role "admin"
    When the viewer is ensured with the admin login "fleet@example.test" and the password "fleet-password"
    Then the check passes
    And the hub was asked to change a user to exactly:
      | role | readonly |

  Scenario: Without the admin login the viewer is not provisioned, which is a warning
    When the viewer is ensured without an admin login
    Then the summary of the check is "BESZEL_VIEWER_UNPROVISIONED"

  Scenario: A rejected admin login is a warning that leaks no detail
    Given a hub that rejects the fleet admin login
    When the viewer is ensured with the admin login "fleet@example.test" and the password "fleet-password"
    Then the check warns
    And the checks do not contain "fleet-password"
