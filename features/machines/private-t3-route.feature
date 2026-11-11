Feature: A worker's T3 is reached over a private Tailscale Serve route
  A playbook publishes the route on port 443 when the port has no owner.
  Beforehand a conflicting owner is refused; afterwards the route has to be
  observed. Nothing here resets Serve, enables Funnel, pairs or restarts.

  Background:
    Given the command "tailscale status --json" prints:
      """
      {
        "BackendState": "Running",
        "Self": {
          "ID": "fixture",
          "HostName": "dev",
          "DNSName": "dev.fixture.ts.net.",
          "OS": "linux",
          "Online": true,
          "TailscaleIPs": ["100.64.0.1"]
        },
        "Peer": {}
      }
      """

  Scenario: A route that is already there is verified, and Serve is left alone
    Given the command "tailscale serve status --json" prints:
      """
      {
        "TCP": { "443": { "HTTPS": true } },
        "Web": {
          "dev.fixture.ts.net:443": {
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:3773" } }
          }
        }
      }
      """
    When the worker's private T3 route is converged
    Then the check passes
    And the route was not published
    And only these commands ran:
      | tailscale status --json       |
      | tailscale serve status --json |

  Scenario: Public Funnel access on the port is a conflict, never reset
    Given the command "tailscale serve status --json" prints:
      """
      {
        "TCP": { "443": { "HTTPS": true } },
        "Web": {
          "dev.fixture.ts.net:443": {
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:3773" } }
          }
        },
        "AllowFunnel": { "dev.fixture.ts.net:443": true }
      }
      """
    When the worker's private T3 route is converged
    Then the summary of the check is "T3_PRIVATE_ROUTE_CONFLICT"
    And the route was not published
    And 2 commands ran

  Scenario: A missing route is published by the play and then observed
    Given until the route is published the command "tailscale serve status --json" prints "{}", and afterwards:
      """
      {
        "TCP": { "443": { "HTTPS": true } },
        "Web": {
          "dev.fixture.ts.net:443": {
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:3773" } }
          }
        }
      }
      """
    And publishing the route succeeds
    When the worker's private T3 route is converged
    Then the check passes
    And the route was published

  Scenario: A route the play says it published but nobody observes is not accepted
    Given the command "tailscale serve status --json" prints:
      """
      {}
      """
    And publishing the route succeeds
    When the worker's private T3 route is converged
    Then the summary of the check is "T3_PRIVATE_ROUTE_UNVERIFIED"

  Scenario: A route the play could not publish is still required
    Given the command "tailscale serve status --json" prints:
      """
      {}
      """
    And publishing the route fails
    When the worker's private T3 route is converged
    Then the summary of the check is "T3_PRIVATE_ROUTE_REQUIRED"
