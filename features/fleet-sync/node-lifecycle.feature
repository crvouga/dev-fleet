Feature: A worker is replaced or retired with one command
  Workers are cattle. A fresh machine takes a worker's place under the same id
  with fleet-node-replace, and a worker leaves the fleet for good with
  fleet-node-retire. Both preview what they would do until --apply --yes, and
  running either again changes nothing more.

  Background:
    Given the manager has enrolled "worker-one" and "worker-two" from the example fleet, bound to the devices "old-one" and "old-two"
    And the manager resolves the SSH alias "worker-one" to "worker-one.tail0a1b2c.ts.net"
    And Vault holds the accessor "acc-worker-one-0001" of the token of "worker-one"
    And the fleet state records that revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" was applied

  Rule: Retiring a worker revokes everything that let it in

    Scenario: A preview says what would change, and changes nothing
      When the operator runs fleet-node-retire for "worker-one"
      Then the report lists these planned steps:
        | auth:worker-token     |
        | ssh:host-key          |
        | enrollment:connection |
        | state:retired         |
      And nothing was run on Vault or Ansible
      And the roster still holds "worker-one"

    Scenario: A retired worker's token is revoked, its host key forgotten and a tombstone left
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And Vault revoked the token with the accessor "acc-worker-one-0001"
      And no command line contains a Vault token
      And Ansible forgot the host key of "worker-one.tail0a1b2c.ts.net"
      And the roster holds only "worker-two"
      And the fleet state records "worker-one" as retired

    Scenario: Retiring twice changes nothing more
      Given the operator has retired "worker-one"
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And the roster holds only "worker-two"
      And the fleet state records "worker-one" as retired, at the time of the first retirement

  Rule: Replacing a worker binds its id to the new machine

    Background:
      Given the tailnet shows "worker-one" online as the new device "new-one"

    Scenario: The new device, its host key and a token of its own replace the old ones
      When the operator runs fleet-node-replace for "worker-one" with the host key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheNewMachine" and --apply --yes
      Then the command exits with 0
      And the roster binds "worker-one" to "new-one"
      And Ansible pinned "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheNewMachine" for "worker-one.tail0a1b2c.ts.net"
      And Vault revoked the token with the accessor "acc-worker-one-0001"
      And Vault issued "worker-one" a token under the policy "fleet-worker-worker-one"
      And no command line contains a Vault token

    Scenario: Replacing twice is a no-op
      Given the operator has replaced "worker-one"
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 0
      And Vault issued no token
      And the roster binds "worker-one" to "new-one"

    Scenario: Without an online device carrying its name, nothing is changed
      Given the tailnet shows "worker-one" offline
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 1
      And the report mentions "TAILSCALE_NODE_MISSING"
      And the roster binds "worker-one" to "old-one"
