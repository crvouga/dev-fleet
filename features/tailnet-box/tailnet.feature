@tailnet-box @slow
Feature: A worker joins a real tailnet unattended, is reached only through it, and leaves no device behind
  The tailnet is a remote worker's only private path, so it is proven against
  a real control plane: a self-hosted Headscale at the version and digest its
  lock pins (features/tailnet-box/support/lock.json), serving TLS from a
  certificate authority made for the run, with its own relay. A "manager" and
  two workers are disposable Ubuntu machines booted with systemd on one
  private Docker network; each runs tailscaled in the kernel (a TUN device and
  NET_ADMIN, from a privileged container). Keys are minted through the
  production tailnet control (src/tailnet-control.ts) and the machines join
  with the production Tailscale play (ansible/ubuntu/tailscale.yml). No
  account with any hosted service is used. Runs only when
  DEVFLEET_TEST_TAILNET_BOX is set: weekly, by hand and before every release
  (.github/workflows/tailnet.yml).

  Background:
    Given a self-hosted Headscale at the version its lock pins, serving "https://headscale.fleet.test:8443" on a private network
    And the fleet declares the tailnet control plane:
      """
      { "api": "headscale", "url": "https://headscale.fleet.test:8443", "tag": "tag:fleet-worker", "user": "1" }
      """

  Scenario: A new worker joins under its declared ID with a single-use key minted for it
    Given a disposable Ubuntu machine "worker-one" on that network
    When the Tailscale play runs on "worker-one" with a key the control plane minted for "worker-one"
    Then "worker-one" is signed in to the tailnet
    And the control plane lists one device named "worker-one", tagged "tag:fleet-worker"
    And the device "worker-one" reports for itself is the one the control plane lists
    And "worker-one" holds no enrolment key any more

  Scenario: A key that was used once is refused, and the worker stays off the tailnet
    Given "worker-one" joined the tailnet
    And a disposable Ubuntu machine "worker-two" on that network
    When the Tailscale play runs on "worker-two" with the key "worker-one" joined with
    Then the play stops at "Require genuine device authentication before claiming connectivity"
    And "worker-two" is not signed in to the tailnet
    And the control plane lists no device named "worker-two"
    And "worker-two" holds no enrolment key any more

  Scenario: The manager finds each declared worker on the tailnet by name and by the device it enrolled
    Given "worker-one" joined the tailnet
    And "worker-two" joined the tailnet
    And "manager" joined the tailnet with a key of its own user, untagged
    When the manager reads the tailnet
    Then these declared workers match these devices:
      | worker     | device     |
      | worker-one | worker-one |
      | worker-two | worker-two |
    And the manager finds "worker-one" by the device ID it reports for itself, at the tailnet name "worker-one.tailnet.test"
    And the fleet's tailnet holds no leftover device

  Scenario: A worker's services answer over the tailnet and not over the other network
    The fleet firewall (ansible/ubuntu/tasks/firewall.yml) admits inbound
    traffic only over loopback and the tailnet. A listener on every address
    is the worst case: it answers on the private network until the firewall
    is loaded.
    Given "manager" joined the tailnet with a key of its own user, untagged
    And "worker-one" joined the tailnet
    And "worker-one" serves HTTP on port 8080 on every address, which the manager reaches over the private network
    When the fleet firewall is applied on "worker-one"
    Then the manager reaches port 8080 of "worker-one" over the tailnet
    But the manager does not reach port 8080 of "worker-one" over the private network

  Scenario: A worker destroyed and created again under the same ID is one device once its old one is removed
    The old device is removed through the tailnet clean-up fleet-node-retire
    uses (src/tailnet-cleanup.ts), by the device ID the worker reported for
    itself, before the new machine joins.
    Given "worker-two" joined the tailnet
    When "worker-two" is destroyed, its device is removed through the tailnet clean-up, and a new machine joins as "worker-two" with a new key
    Then the clean-up reported "tailscale:device" as "pass"
    And the control plane lists one device named "worker-two", tagged "tag:fleet-worker"
    And that device is not the one that was removed
    And the fleet's tailnet holds no leftover device
