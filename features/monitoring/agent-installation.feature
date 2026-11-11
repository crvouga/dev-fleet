Feature: A machine installs monitoring only from the reviewed revision, and only its own part
  The manager sends a machine a request, and the machine applies it from its
  own checkout of the revision. A checkout that is not that clean revision is
  refused before anything is installed. The hub runs only on the manager:
  workers only ever run the agent, and only against the manager's private hub.

  Background:
    Given the example fleet, whose manager "manager-mac" is reached at "manager-mac-1.tail0a1b2c.ts.net" and serves the hub on port 8443
    And the example fleet declares the worker "worker-one" and no machine "unknown-node"
    And these commands answer:
      | command                       | answer                                          |
      | git rev-parse HEAD            | prints aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      | git rev-parse --show-toplevel | prints /fleet/checkout                          |
      | git status --porcelain        | succeeds                                        |

  Scenario Outline: A checkout <that is wrong> is refused before anything is installed
    Given the command "<command>" <answer>
    When the machine is asked, in the checkout "/fleet/checkout", to apply:
      """
      {
        "node": "worker-one",
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mode": "hub",
        "hubUrl": "https://hub.example.ts.net:8443"
      }
      """
    Then it is refused with "BESZEL_SOURCE_MISMATCH"
    And every command that ran was a "git" command

    Examples:
      | that is wrong               | command                       | answer                                          |
      | at another revision         | git rev-parse HEAD            | prints bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
      | nested in another checkout  | git rev-parse --show-toplevel | prints /another-checkout                        |
      | with uncommitted changes    | git status --porcelain        | prints  M ansible/monitoring/agent.yml          |
      | whose status cannot be read | git status --porcelain        | fails                                           |

  Scenario: A worker refuses to run the hub: the hub runs only on the manager
    When the machine is asked, in the checkout "/fleet/checkout", to apply:
      """
      {
        "node": "worker-one",
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mode": "hub",
        "hubUrl": "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      }
      """
    Then it is refused with exactly "BESZEL_NOT_HUB"
    And the refusal is reported with the summary "BESZEL_NOT_HUB"
    And the remedy of the refusal contains "runs only on the manager"

  Scenario: An agent accepts only the manager's hub address
    When the machine is asked, in the checkout "/fleet/checkout", to apply:
      """
      {
        "node": "worker-one",
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "publicKey": "ssh-ed25519 fixture",
        "token": "disposable-fixture-token",
        "hubUrl": "https://worker-one.tail0a1b2c.ts.net:8443"
      }
      """
    Then it is refused with "BESZEL_HUB_MISMATCH"

  Scenario: A machine the fleet configuration does not declare is refused
    When the machine is asked, in the checkout "/fleet/checkout", to apply:
      """
      {
        "node": "unknown-node",
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "publicKey": "ssh-ed25519 fixture",
        "token": "disposable-fixture-token",
        "hubUrl": "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      }
      """
    Then it is refused with "BESZEL_NOT_ENROLLED"

  Scenario: A failure that is not a known refusal is reported without its detail
    When an installation fails with the error "raw secret detail"
    Then the refusal is reported with the summary "BESZEL_OPERATION_INCOMPLETE"
    And the reported refusal does not contain "raw secret detail"
