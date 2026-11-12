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
        | beszel:system         |
        | tailscale:device      |
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

  Rule: A worker that is replaced or retired leaves no stale identity behind
    A rented machine is rebuilt as a matter of routine. Its monitoring
    system, the manager's T3 link to it, its tailnet device and its token
    each go with it, so the next machine under the same id starts clean.

    Background:
      Given the monitoring hub watches "worker-one" at "worker-one-old.tail0a1b2c.ts.net"
      And the monitoring hub watches "worker-two" at "worker-two.tail0a1b2c.ts.net"
      And the roster records the T3 environment "0b0c0d0e-1111-4222-8333-444455556666" of "worker-one"

    Scenario: Retiring deletes the monitoring system and the T3 link, and says the device is left to a person
      Without a tailnet control plane in fleet.json nothing can remove a
      device, so the report says what a person does instead.
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And the monitoring hub watches only:
        | name       | host                         |
        | worker-two | worker-two.tail0a1b2c.ts.net |
      And the manager's T3 forgot the environment "0b0c0d0e-1111-4222-8333-444455556666"
      And the report has the check "tailscale:device" skipped, saying "no tailnet control is configured"
      And the remedy of the check "tailscale:device" says "Remove the device old-one in the tailnet's admin console"

    Scenario: With a tailnet control plane, retiring removes the old device
      The control plane fleet.json declares removes it, asked with the
      tailnet-admin credential, so the next machine under the same id gets
      the declared name instead of a numbered one.
      Given the fleet declares the tailnet control plane:
        """
        { "api": "tailscale", "tag": "tag:fleet-worker" }
        """
      And the secrets provider holds a tailnet-admin credential generated for this scenario
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And the control plane was asked to delete only the device "old-one"
      And the control plane was asked "DELETE" "https://api.tailscale.com/api/v2/device/old-one"
      And the request carried the credential as a bearer token
      And the report has the check "tailscale:device" passed, saying "The tailnet no longer holds the device old-one"

    Scenario: Replacing points the monitoring system at the new machine, leaves the T3 pairing to fleet-sync and removes the old device
      The new machine's T3 does not run until fleet-sync converges it, so
      the next fleet-sync pairs the manager with it.
      Given the fleet declares the tailnet control plane:
        """
        { "api": "tailscale", "tag": "tag:fleet-worker" }
        """
      And the secrets provider holds a tailnet-admin credential generated for this scenario
      And the tailnet shows "worker-one" online as the new device "new-one"
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 0
      And the monitoring hub watches only:
        | name       | host                         |
        | worker-one | worker-one.tail0a1b2c.ts.net |
        | worker-two | worker-two.tail0a1b2c.ts.net |
      And the manager's T3 forgot the environment "0b0c0d0e-1111-4222-8333-444455556666"
      And the roster records no T3 environment of "worker-one"
      And the report has the check "t3:link" skipped, saying "devfleet fleet-sync --node worker-one pairs the manager with it once it runs"
      And the fleet state asks for a T3 pairing of "worker-one"
      And the control plane was asked to delete only the device "old-one"
      And the report has the check "tailscale:device" passed, saying "The tailnet no longer holds the device old-one"

    Scenario: Without the tailnet-admin credential the device is left to a person
      Given the fleet declares the tailnet control plane:
        """
        { "api": "tailscale", "tag": "tag:fleet-worker" }
        """
      And the secrets provider holds no tailnet-admin credential
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And the control plane was asked nothing
      And the report has the check "tailscale:device" skipped, saying "the secrets provider holds no tailnet-admin"

  Rule: The manager pairs its T3 with a replaced worker's new environment
    A rebuilt machine runs a new T3 environment, and the manager pairs with
    it without a person. The worker mints a one-time pairing code over the
    SSH session; the manager hands it to its own T3 server, on this machine,
    in the body of one request, under a session issued for that request and
    revoked after it. The code is a secret: it never appears on a command
    line, in a report, in what a command prints or in the fleet state.

    Background:
      Given the tailnet shows "worker-one" online as the new device "new-one"
      And the manager's T3 server runs at "http://127.0.0.1:3773"

    Scenario: A new machine whose T3 already runs is paired at once
      Given the T3 of "worker-one" runs the environment "7a7b7c7d-1111-4222-8333-444455556666"
      And the manager's T3 links the environment it is handed a code for
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 0
      And the report has the check "t3:link" passed, saying "The manager's T3 is paired with the T3 environment 7a7b7c7d-1111-4222-8333-444455556666 of worker-one"
      And the roster records the T3 environment "7a7b7c7d-1111-4222-8333-444455556666" of "worker-one"
      And the manager's T3 was asked to link "https://worker-one.tail0a1b2c.ts.net" as "7a7b7c7d-1111-4222-8333-444455556666" with the code minted on "worker-one"
      And the pairing code was sent only to "http://127.0.0.1:3773", in the body of the link request
      And the session issued for the link was revoked
      And the pairing code appears in no command line, report, printed output or fleet state
      And the fleet state asks for no T3 pairing of "worker-one"

    Scenario: A new machine whose T3 did not run yet is paired by the next fleet-sync
      Given the operator has replaced "worker-one" before its T3 ran
      And the T3 of "worker-one" runs the environment "7a7b7c7d-1111-4222-8333-444455556666"
      And the manager's T3 links the environment it is handed a code for
      When fleet-sync pairs the T3 of "worker-one" if it was asked to
      Then fleet-sync reports:
        | id      | status |
        | t3:link | pass   |
      And the roster records the T3 environment "7a7b7c7d-1111-4222-8333-444455556666" of "worker-one"
      And the fleet state asks for no T3 pairing of "worker-one"
      And the session issued for the link was revoked
      And the pairing code appears in no command line, report, printed output or fleet state

    Scenario: A worker nobody replaced is left to a person
      A worker's first pairing is approved by a person in the manager's T3.
      Given the T3 of "worker-one" runs the environment "7a7b7c7d-1111-4222-8333-444455556666"
      When fleet-sync pairs the T3 of "worker-one" if it was asked to
      Then fleet-sync reports:
        | id | status |
      And no pairing code was minted on "worker-one"

    Scenario Outline: A refused pairing fails, says why, and is asked for again
      Given the T3 of "worker-one" runs the environment "7a7b7c7d-1111-4222-8333-444455556666"
      And the manager's T3 refuses the link because "<reason>"
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 1
      And the report has the check "t3:link" failed, saying "T3_LINK_PAIRING_FAILED"
      And the remedy of the check "t3:link" says "<remedy>"
      And the roster records no T3 environment of "worker-one"
      And the fleet state asks for a T3 pairing of "worker-one"
      And the session issued for the link was revoked
      And the pairing code appears in no command line, report, printed output or fleet state

      Examples:
        | reason           | remedy                                                   |
        | disabled         | Linked environments is off in the manager's T3           |
        | pairing_rejected | The T3 of worker-one refused the link (pairing_rejected) |
        | unreachable      | The T3 of worker-one refused the link (unreachable)      |

    Scenario: A manager's T3 that is not on this machine is never handed a code
      Given the manager's T3 server runs at "http://192.0.2.10:3773"
      And the T3 of "worker-one" runs the environment "7a7b7c7d-1111-4222-8333-444455556666"
      And the manager's T3 links the environment it is handed a code for
      When the operator runs fleet-node-replace for "worker-one" with --apply --yes
      Then the command exits with 1
      And the remedy of the check "t3:link" says "The manager's T3 did not answer on this machine"
      And the manager's T3 was sent nothing
      And no session was issued for a link
      And the pairing code appears in no command line, report, printed output or fleet state

  Rule: A worker reached from declared data has its host key pinned in the fleet state
    The operator's ~/.ssh/known_hosts is neither needed nor changed: the key
    is kept in the fleet state, and the manager connects against a
    known_hosts file of its own rendered from it.

    Background:
      Given fleet.json declares "worker-one" with no SSH alias, so the roster reaches it by its tailnet name
      And the tailnet shows "worker-one" online as the new device "new-one"

    Scenario: Replacing pins the new key with one command
      When the operator runs fleet-node-replace for "worker-one" with the host key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheNewMachine" and --apply --yes
      Then the command exits with 0
      And the fleet state pins "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheNewMachine" for "worker-one"
      And the fleet-owned known_hosts pins exactly:
        """
        devfleet-worker-one ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheNewMachine
        """
      And no personal known_hosts was changed

    Scenario: Retiring forgets the pinned key
      Given the operator has replaced "worker-one"
      When the operator runs fleet-node-retire for "worker-one" with --apply --yes
      Then the command exits with 0
      And the fleet state pins no host key for "worker-one"
      And the fleet-owned known_hosts pins exactly:
        """
        """

  Rule: Workers that come from worker records come and go with their records
    A record that appears is a declared worker, enrolled by the next sync. One
    that disappears is retired by the same path as fleet-node-retire. A worker
    someone listed in fleet.json by hand is never retired by itself.

    Scenario: A worker whose record disappeared is retired by the next sync
      Given the fleet state records that "worker-three" was enrolled from a worker record, bound to the device "old-three"
      And the monitoring hub watches "worker-three" at "worker-three.tail0a1b2c.ts.net"
      When fleet-sync reads the worker records
      Then fleet-sync reports:
        | id                | status |
        | enrollment:record | pass   |
      And the roster does not hold "worker-three"
      And the fleet state records "worker-three" as retired
      And the monitoring hub watches only:
        | name | host |

    Scenario: A preview only plans the retirement
      Given the fleet state records that "worker-three" was enrolled from a worker record, bound to the device "old-three"
      When fleet-sync reads the worker records to preview them
      Then fleet-sync reports:
        | id                | status |
        | enrollment:record | skip   |
      And the roster holds "worker-three"

    Scenario: A worker removed from fleet.json by hand is not retired by itself
      Given the roster still holds "worker-three", which fleet.json listed by hand
      When fleet-sync reads the worker records
      Then fleet-sync reports:
        | id | status |
      And the roster holds "worker-three"
