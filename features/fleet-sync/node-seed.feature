Feature: A new worker joins the fleet by itself from a seed
  devfleet fleet-node-seed writes the cloud-init user data a stock Ubuntu
  image boots with: the worker account with the manager's key, the privilege
  rule fleet-sync expects, a host key generated for the machine and the
  pinned Tailscale, which joins with a short-lived single-use auth key. No
  person opens an SSH session to prepare it, and the manager pins the host key
  before the machine answers, so nothing is trusted on first use.

  Background:
    Given the manager's public key is "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIManagerPublicKeyForTheSeed dev@manager"
    And the secrets provider holds a Tailscale auth key generated for this scenario
    And the secrets provider holds these secrets:
      | proxy-client-key            | long-lived-proxy-key           |
      | monitoring-account-password | long-lived-monitoring-password |
      | monitoring-tunnel-token     | long-lived-monitoring-tunnel   |
      | proxy-tunnel-token          | long-lived-proxy-tunnel        |
    And ssh-keygen makes the host key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedHostKeyOfTheWorker worker-one"

  Scenario: The seed carries everything first boot needs
    When the operator seeds "worker-one"
    Then the command exits with 0
    And the seed is private to the operator
    And the seed is cloud-init user data where:
      | field                         | value                                                                                       |
      | hostname                      | worker-one                                                                                  |
      | users.0.name                  | dev                                                                                         |
      | users.0.lock_passwd           | true                                                                                        |
      | users.0.ssh_authorized_keys.0 | ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIManagerPublicKeyForTheSeed dev@manager                 |
      | ssh_pwauth                    | false                                                                                       |
      | ssh_keys.ed25519_public       | ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedHostKeyOfTheWorker worker-one                 |
      | write_files.0.path            | /etc/sudoers.d/personal-fleet-dev                                                           |
      | write_files.0.content         | # Managed by personal Fleet: designated development user\ndev ALL=(ALL:ALL) NOPASSWD: ALL\n |
      | write_files.0.permissions     | 0440                                                                                        |
    And the seed installs the Tailscale version ansible/ubuntu/policy.json pins
    And the seed deletes the auth key once the machine has joined
    And the answer names the host key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedHostKeyOfTheWorker"

  Scenario: The seed holds no long-lived secret, and nothing printed holds the auth key
    When the operator seeds "worker-one"
    Then the seed contains none of these:
      | long-lived-proxy-key           |
      | long-lived-monitoring-password |
      | long-lived-monitoring-tunnel   |
      | long-lived-proxy-tunnel        |
    And nothing printed or answered contains the auth key

  Scenario: Bare metal gets an Ubuntu autoinstall file carrying the same user data
    When the operator seeds "worker-one" with --autoinstall
    Then the seed is an autoinstall file whose user data names the host "worker-one"

  Scenario: With --apply --yes the manager pins the host key before the machine answers
    Given the manager resolves the SSH alias "worker-one" to "worker-one.tail0a1b2c.ts.net"
    When the operator seeds "worker-one" with --apply --yes
    Then Ansible pinned "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedHostKeyOfTheWorker" for "worker-one.tail0a1b2c.ts.net"

  Scenario: A key that is not a Tailscale auth key is refused
    Given the secrets provider holds these secrets:
      | tailnet-auth-key | placeholder-that-is-not-an-auth-key |
    When the operator seeds "worker-one"
    Then the seed is refused with "not a Tailscale auth key"
