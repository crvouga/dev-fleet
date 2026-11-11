Feature: fleet-sync enrolls every machine on the manager's monitoring hub
  The hub runs only on the manager. A worker gets the agent, installed over
  SSH and enrolled against that hub; the manager enrolls itself on its own hub
  and installs its agent locally.

  Background:
    Given the tailnet shows these computers:
      | id         | name        | dns                             | os    | address    | online | this computer |
      | manager-id | manager-mac | manager-mac-1.tail0a1b2c.ts.net | macOS | 100.64.0.1 | yes    | yes           |
      | worker-id  | worker-one  | worker-one.tail0a1b2c.ts.net    | linux | 100.64.0.2 | yes    | no            |
    And the roster entry "worker-one", with the workspace "/unused" and the Tailscale ID "worker-id"
    And the hub on the manager answers its health check
    And the hub, at version "0.21.1" with the key "ssh-ed25519 fixture", accepts the fleet login as user "abcdefghijklmno"
    And the hub has no system registered
    And every command on a worker answers with the check "beszel:service" as "pass" with the summary "ok"

  Rule: A worker is enrolled against the hub on the manager

    Scenario: Enrolling a worker targets the manager's hub and installs only the agent
      When the monitoring of that machine is synchronized at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the hubs logged in to are exactly:
        | https://manager-mac-1.tail0a1b2c.ts.net:8443 |
      And the first command run has the argument "https://manager-mac-1.tail0a1b2c.ts.net:8443/api/health"
      And the first record sent to the hub has:
        | name | worker-one                   |
        | host | worker-one.tail0a1b2c.ts.net |
      And the command run over SSH names "monitoring/apply.ts"
      And the first check is "beszel:service"

    Scenario: An unreachable hub stops before enrollment with a clear code
      Given the hub on the manager does not answer its health check
      And logging in to the hub would fail the scenario
      When the monitoring of that machine is synchronized at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the first check's summary is "BESZEL_HUB_UNREACHABLE"
      And the first check's remedy contains "runs on the manager"
      And nothing but "curl" was run

    Scenario Outline: <machine> is never enrolled as a worker
      Given the roster entry "<id>", with the workspace "/unused" and the Tailscale ID "worker-id"
      When the monitoring of that machine is synchronized at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the first check's summary is "BESZEL_NOT_ENROLLED"
      And no command was run

      Examples:
        | machine                              | id           |
        | The manager                          | manager-mac  |
        | A machine the fleet does not declare | unknown-node |

    Scenario: A worker missing from the tailnet keeps its code
      Given the roster entry "worker-one", with the workspace "/unused" and the Tailscale ID "absent"
      When the monitoring of that machine is synchronized at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the first check's summary is "BESZEL_NODE_TAILNET_REQUIRED"

    Scenario: A rejected fleet login keeps its code and names the account
      Given logging in to the hub fails with "BESZEL_ACCOUNT_REQUIRED"
      When the monitoring of that machine is synchronized at revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the first check's summary is "BESZEL_ACCOUNT_REQUIRED"
      And the first check's remedy contains "fleet-manager@example.com"

  Rule: The manager is a monitored system on its own hub

    Scenario: The manager enrolls itself and installs its agent locally
      Given installing the manager's own agent reports the check "beszel:service" as "pass" with the summary "ok"
      When the monitoring of the manager is enrolled from the checkout "/checkout"
      Then the first record sent to the hub has:
        | name | manager-mac                     |
        | host | manager-mac-1.tail0a1b2c.ts.net |
      And the manager's own agent was installed exactly once, for "manager-mac" against the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      And no command was run over SSH
      And the first check is "beszel:service"

    Scenario: A failed install of the manager's agent is reported, never hidden
      Given installing the manager's own agent reports the check "beszel:installation" as "fail" with the summary "BESZEL_INSTALLATION_INCOMPLETE"
      When the monitoring of the manager is enrolled from the checkout "/checkout"
      Then the summaries of the checks are exactly:
        | BESZEL_INSTALLATION_INCOMPLETE |

    Scenario: With an unreachable hub the manager's monitoring keeps its code
      Given the hub on the manager does not answer its health check
      And logging in to the hub would fail the scenario
      When the monitoring of the manager is enrolled from the checkout "/checkout"
      Then the first check's summary is "BESZEL_HUB_UNREACHABLE"
