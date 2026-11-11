Feature: The health of the workers includes what the dashboard knows of them
  The hub always runs on the manager, reached by its MagicDNS name. It must
  answer privately, and every worker must be registered on it, connected and
  reporting fresh samples. What cannot be verified is reported, never passed.

  Background:
    Given the tailnet shows these computers:
      | id            | name        | dns                             | os    | address    | online | this computer |
      | id-manager    | manager-mac | manager-mac-1.tail0a1b2c.ts.net | macOS | 100.64.0.2 | yes    | yes           |
      | id-worker-one | worker-one  | worker-one.tail0a1b2c.ts.net    | linux | 100.64.0.1 | yes    | no            |
      | id-worker-two | worker-two  | worker-two.tail0a1b2c.ts.net    | linux | 100.64.0.1 | yes    | no            |

  Rule: The dashboard is the hub on the manager

    Scenario: The dashboard is reached by the manager's MagicDNS name
      When the dashboard is looked up
      Then the dashboard is at "https://manager-mac-1.tail0a1b2c.ts.net:8443"

    Scenario: With the manager not visible on the tailnet there is no dashboard
      Given the tailnet shows no computer
      When the dashboard is looked up
      Then there is no dashboard

  Rule: Every worker gets registration, connection and freshness evidence

    Scenario: A healthy hub vouches for every worker
      Given health reports, without any check yet, for:
        | worker-one.tail0a1b2c.ts.net |
        | worker-two.tail0a1b2c.ts.net |
      And the hub and its public address answer their health checks
      And the hub, at version "0.21.1" with the key "ssh-ed25519 x", accepts the fleet login
      And the hub knows every machine as the system "aaaaaaaaaaaaaaa" with the status "up", and has just received a sample
      When the evidence of the dashboard is added to the health reports
      Then the dashboard is at "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      And the health report of "dashboard" has exactly these checks:
        | check                  | status |
        | beszel:hub             | pass   |
        | beszel:public-endpoint | pass   |
      And the health report of "worker-one.tail0a1b2c.ts.net" has exactly these checks:
        | check               | status |
        | beszel:version      | pass   |
        | beszel:registration | pass   |
        | beszel:connection   | pass   |
        | beszel:freshness    | pass   |
      And the health report of "worker-two.tail0a1b2c.ts.net" has exactly these checks:
        | check               | status |
        | beszel:version      | pass   |
        | beszel:registration | pass   |
        | beszel:connection   | pass   |
        | beszel:freshness    | pass   |

    Scenario: An unreachable hub or a missing Vault session on the manager is reported, never passed
      Given every request to the hub fails with "private connection detail"
      And logging in to the hub fails with "BESZEL_ACCOUNT_REQUIRED"
      When the evidence of the dashboard is added to the health reports
      Then the health report of "dashboard" has exactly these checks:
        | check                  | status |
        | beszel:hub             | fail   |
        | beszel:public-endpoint | warn   |
        | beszel:access          | skip   |
      And the health reports do not mention "private connection detail"

    Scenario: With the manager not visible on the tailnet no evidence can be gathered
      Given the tailnet shows no computer
      When the evidence of the dashboard is added to the health reports
      Then there is no dashboard
