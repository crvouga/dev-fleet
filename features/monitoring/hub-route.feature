Feature: Only the hub's own proxy may hold the dashboard port
  Tailscale Serve offers the hub to the tailnet on port 8443 and proxies to
  the hub on the manager's loopback. Serve may hold other routes, and they are
  left alone. On the hub's port only its own proxy is accepted: Funnel, raw
  TCP or another application there needs a reviewed migration, never a reset.

  Scenario: Serve with nothing on the dashboard port has no route yet
    Given Tailscale Serve reports:
      """
      {}
      """
    When the route to the hub "https://home.example.ts.net:8443" is looked for
    Then there is no route yet

  Scenario: The hub's own proxy on the dashboard port is the route
    Given Tailscale Serve reports:
      """
      {
        "TCP": { "8443": { "HTTPS": true } },
        "Web": {
          "home.example.ts.net:8443": {
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:8090" } }
          }
        }
      }
      """
    When the route to the hub "https://home.example.ts.net:8443" is looked for
    Then the route is there

  Scenario: Funnel on the dashboard port is a conflict
    Given Tailscale Serve reports:
      """
      {
        "TCP": { "8443": { "HTTPS": true } },
        "Web": {
          "home.example.ts.net:8443": {
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:8090" } }
          }
        },
        "AllowFunnel": { "home.example.ts.net:8443": true }
      }
      """
    When the route to the hub "https://home.example.ts.net:8443" is looked for
    Then the route is a conflict

  Scenario: Raw TCP on the dashboard port requires a migration
    Given Tailscale Serve reports:
      """
      { "TCP": { "8443": { "TCPForward": "localhost:9999" } } }
      """
    When the route to the hub "https://home.example.ts.net:8443" is looked for
    Then the route is a conflict

  Scenario: Another application on the dashboard port requires a migration
    Given Tailscale Serve reports:
      """
      {
        "Web": {
          "home.example.ts.net:8443": {
            "Handlers": { "/": { "Proxy": "http://localhost:9000" } }
          }
        }
      }
      """
    When the route to the hub "https://home.example.ts.net:8443" is looked for
    Then the route is a conflict
