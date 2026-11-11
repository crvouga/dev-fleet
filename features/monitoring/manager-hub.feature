Feature: The hub runs on the manager, and only there
  The one Beszel hub runs on the manager under Docker Desktop, with its data
  in the home of the manager's user. A playbook applies it; the token of the
  dashboard's connector comes from the manager's own Vault session and reaches
  the playbook in its private variables, never in an argument or in a report.
  A second playbook publishes the private route. Then the hub's health is
  measured on the manager itself and over the tailnet.

  Rule: The manager converges its own hub

    Background:
      Given the example fleet, whose manager "manager-mac" is reached at "manager-mac-1.tail0a1b2c.ts.net" and serves the hub on port 8443
      And these commands answer:
        | command                                                                                         | answer                           |
        | /usr/sbin/scutil --get LocalHostName                                                            | prints Manager-Mac\n             |
        | docker info --format {{.ServerVersion}}                                                         | prints 29.0.0                    |
        | vault kv get -address=https://vault.example.com -mount=secret -field=TUNNEL_TOKEN beszel/tunnel | prints never-output-tunnel-token |
        | curl … http://127.0.0.1:8090/api/health                                                         | succeeds                         |
        | curl … https://manager-mac-1.tail0a1b2c.ts.net:8443/api/health                                  | succeeds                         |
      And the playbook "hub-darwin.yml" succeeds
      And the playbook "hub-route-darwin.yml" succeeds
      And until the playbook "hub-route-darwin.yml" has run the command "/opt/homebrew/bin/tailscale serve status --json" prints "{}", and afterwards:
        """
        {
          "TCP": { "8443": { "HTTPS": true } },
          "Web": {
            "manager-mac-1.tail0a1b2c.ts.net:8443": {
              "Handlers": { "/": { "Proxy": "http://127.0.0.1:8090" } }
            }
          }
        }
        """
      And the home of the manager's user is "/Users/dev"
      And the manager's Tailscale CLI is "/opt/homebrew/bin/tailscale"
      And the manager holds no fleet login for the hub
      And the viewer of the dashboard is in place
      And the hub's backups are in place
      And no apply leaves a receipt

    Scenario: The hub converges on the manager, with its data in the user's home and a private route
      The route is declared: its playbook publishes it, never this code.
      When the hub is converged on the manager
      Then these checks are reported:
        | check                  | status |
        | beszel:hub             | pass   |
        | beszel:public-endpoint | pass   |
        | beszel:public-viewer   | pass   |
        | beszel:backup          | pass   |
      And the first playbook run, "hub-darwin.yml", was given exactly these variables:
        | beszel_hub_url      | https://manager-mac-1.tail0a1b2c.ts.net:8443                  |
        | beszel_public_url   | https://beszel.example.com                                    |
        | beszel_auto_login   | public-viewer@example.com                                     |
        | beszel_data_dir     | /Users/dev/Library/Application Support/personal-beszel        |
        | beszel_tunnel_dir   | /Users/dev/Library/Application Support/personal-beszel-tunnel |
        | beszel_tunnel_token | never-output-tunnel-token                                     |
      And the second playbook run, "hub-route-darwin.yml", was given exactly these variables:
        | beszel_tailscale_cli | /opt/homebrew/bin/tailscale |
        | beszel_route_port    | 8443                        |
        | beszel_route_target  | http://127.0.0.1:8090       |
      And no command with the word "--bg" was run
      And no "sudo" command was run
      And no "ssh" command was run
      And no command contains "never-output-tunnel-token"
      And the checks do not contain "never-output-tunnel-token"
      And a command was run with the argument "https://manager-mac-1.tail0a1b2c.ts.net:8443/api/health"

    Scenario: The hub refuses to run anywhere but the manager
      Given the command "/usr/sbin/scutil --get LocalHostName" prints worker-one\n
      When the hub is converged on the manager
      Then the summary of the check is "BESZEL_NOT_MANAGER"
      And the remedy of the check contains "runs only on the manager"
      And 1 command ran

    Scenario: Docker Desktop has to be running before anything about the hub changes
      Given the command "docker info --format {{.ServerVersion}}" fails printing 29.0.0
      When the hub is converged on the manager
      Then the summary of the check is "BESZEL_DOCKER_DESKTOP_REQUIRED"
      And the playbook "hub-darwin.yml" was not run
      And no "vault" command was run

    Scenario: A missing tunnel credential warns without blocking the private hub
      Given the command "vault kv get …" fails
      When the hub is converged on the manager
      Then the check passes
      And the summary of the second check is "BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE"
      And the first playbook run, "hub-darwin.yml", was not given the variable "beszel_tunnel_token"

    Scenario Outline: <what fails> cannot pass readiness
      Given the command "<command>" <answer>
      When the hub is converged on the manager
      Then the summary of the check is "<summary>"

      Examples:
        | what fails                                  | command                                                        | answer    | summary                         |
        | A route nobody observes after its playbook  | /opt/homebrew/bin/tailscale serve status --json                | prints {} | BESZEL_PRIVATE_ROUTE_UNVERIFIED |
        | A hub that does not answer over the tailnet | curl … https://manager-mac-1.tail0a1b2c.ts.net:8443/api/health | fails     | BESZEL_HUB_UNREACHABLE          |

    Scenario: A manager without a Tailscale CLI cannot pass readiness
      Given the manager has no Tailscale CLI
      When the hub is converged on the manager
      Then the summary of the check is "BESZEL_TAILSCALE_REQUIRED"

    Scenario: A fresh hub receives the fleet login, so it can create the account itself
      Given the manager holds the fleet login "fleet@example.test" with the password "x"
      When the hub is converged on the manager
      Then the first playbook run, "hub-darwin.yml", was given these variables among others:
        | beszel_fleet_identity | fleet@example.test |
        | beszel_fleet_password | x                  |

  Rule: The manager's Tailscale CLI is the one on PATH, and else the app's own

    Scenario: A "tailscale" in a directory of PATH is used
      Then with the PATH "/usr/bin:/opt/homebrew/bin" and only "/opt/homebrew/bin/tailscale" on disk, the Tailscale CLI is "/opt/homebrew/bin/tailscale"

    Scenario: Without one on PATH, the CLI inside the Tailscale app is used
      Then the Tailscale app keeps its CLI at "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
      And with the PATH "/usr/bin" and only "/Applications/Tailscale.app/Contents/MacOS/Tailscale" on disk, the Tailscale CLI is "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

    Scenario: With neither, there is no Tailscale CLI
      Then with the PATH "/usr/bin" and no Tailscale on disk, there is no Tailscale CLI

  Rule: The hub's data stays in the home of the manager's user

    Scenario: The data directory is in the user's Application Support
      It is covered by the user's normal backups and is never copied to a worker.
      Then the hub of a manager whose home is "/Users/x" keeps its data in "/Users/x/Library/Application Support/personal-beszel"
