Feature: A new worker reaches ready in one fleet-sync, with no hands on it
  Around each worker's converge, fleet-sync does what a person used to do on
  a new machine: it hands a worker that is not on the tailnet a single-use
  key, keeps an enrolled worker's node key from expiring, creates the
  declared account on an image that lets only root in, and reboots a worker
  once when its first converge needs it, converging it again to verify it.
  A worker that was ready before is never rebooted by that path; only an
  explicit maintenance run reboots it.

  Background:
    Given the secrets provider holds a tailnet-admin credential generated for this scenario
    And the fleet declares the tailnet control plane:
      """
      { "api": "tailscale", "tag": "tag:fleet-worker" }
      """
    And no worker converged in an earlier run

  Rule: A worker that is not on the tailnet joins it with a key nobody sees

    Scenario: A worker the roster knows no tailnet device of is handed a fresh key
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet"
      And the control plane answers 200 with a key generated for this scenario
      And each converge reports:
        | check                   | status | summary  |
        | tailscale:configuration | pass   | Joined   |
      When the worker is deployed
      Then the worker was converged 1 time
      And its first converge was handed the key the control plane issued
      And the deployment reports "tailscale:enrolment-key" as "pass"
      And nothing the deployment reports holds the key

    Scenario: A worker that is on the tailnet is handed no key
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that never expires
      And each converge reports:
        | check                   | status | summary |
        | tailscale:configuration | pass   | Running |
      When the worker is deployed
      Then no converge was handed a key
      And the control plane was asked nothing

    Scenario: A control plane that refuses the credential is reported, and the worker still converges
      Without a key the Tailscale play keeps its TAILSCALE_LOGIN_REQUIRED stop.
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet"
      And the control plane answers 401 with:
        """
        { "message": "PRIVATE_SENTINEL" }
        """
      And each converge reports:
        | check                   | status | summary                           |
        | tailscale:configuration | fail   | TAILSCALE_SETUP_OR_LOGIN_REQUIRED |
      When the worker is deployed
      Then the worker was converged 1 time
      And no converge was handed a key
      And the deployment reports "tailscale:enrolment-key" as "fail", saying "TAILNET_CONTROL_DENIED"
      And "PRIVATE_SENTINEL" appears nowhere in what the deployment reports

  Rule: An enrolled worker's node key does not expire

    Scenario: A worker whose node key expires has expiry disabled through the control plane
      Tagged devices have key expiry disabled on the hosted Tailscale; a worker
      that joined before it was tagged may still have one.
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that expires in 10 days
      And the control plane answers 200 with:
        """
        {}
        """
      And each converge reports:
        | check                   | status | summary |
        | tailscale:configuration | pass   | Running |
      When the worker is deployed
      Then the control plane was asked "POST" "https://api.tailscale.com/api/v2/device/nWorkerOne/key"
      And the deployment reports "tailscale:key-expiry-policy" as "pass"

  Rule: An image that lets only root in gets the declared account

    Scenario: The bootstrap refuses root; the declared account is created over that login and the run continues as it
      Given the roster entry "worker-one", with the workspace "/root/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that never expires
      And the first converge reports:
        | check              | status | summary                        |
        | bootstrap:platform | fail   | ROOT_DEVELOPMENT_USER_REJECTED |
      And each converge after it reports:
        | check           | status | summary  |
        | ubuntu:baseline | pass   | Verified |
      And the playbook "ubuntu/worker-account.yml" succeeds
      When the worker is deployed
      Then the playbook "ubuntu/worker-account.yml" was applied with:
        | variable | value      |
        | target   | worker-one |
        | login    |            |
        | user     | dev        |
      And the worker was converged 2 times
      And the last converge reached it as "dev@worker-one", with the workspace "/home/dev/.local/share/personal/fleet"
      And the deployment reports "worker:account" as "warn", saying "set User dev for the SSH alias worker-one"
      And no check of the deployment says "ROOT_DEVELOPMENT_USER_REJECTED"

    Scenario: A root login that cannot create the account names the account and the command that creates it
      Given the roster entry "worker-one", with the workspace "/root/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that never expires
      And each converge reports:
        | check              | status | summary                        |
        | bootstrap:platform | fail   | ROOT_DEVELOPMENT_USER_REJECTED |
      And the playbook "ubuntu/worker-account.yml" fails, printing "SUDOERS_OWNERSHIP_CONFLICT"
      When the worker is deployed
      Then the worker was converged 1 time
      And the deployment reports "worker:account" as "fail", saying "SUDOERS_OWNERSHIP_CONFLICT"
      And the remedy of "worker:account" names "useradd --create-home --shell /bin/bash --groups sudo dev"

  Rule: A worker that was never ready is rebooted once after its first converge

    Background:
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that never expires

    Scenario: A first converge that needs a reboot is rebooted, waited for and converged again
      Given the first converge reports:
        | check              | status | summary                           |
        | ubuntu:baseline    | pass   | Applied                           |
        | ubuntu:boot-policy | fail   | UBUNTU_MAINTENANCE_REBOOT_PENDING |
      And each converge after it reports:
        | check              | status | summary                 |
        | ubuntu:baseline    | pass   | Applied                 |
        | ubuntu:boot-policy | pass   | Files predate this boot |
      And the playbook "ubuntu/reboot.yml" succeeds
      When the worker is deployed
      Then the playbook "ubuntu/reboot.yml" was applied with:
        | variable | value                                    |
        | target   | worker-one                               |
        | home     | /home/dev                                |
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
        | reason   | first-converge                           |
        | force    | false                                    |
      And the worker was converged 2 times
      And the deployment reports "worker:reboot" as "pass"
      And the deployment reports "ubuntu:boot-policy" as "pass"

    Scenario: A worker that was ready before is never rebooted for its first converge
      Given "worker-one" converged in an earlier run
      And each converge reports:
        | check              | status | summary                           |
        | ubuntu:boot-policy | fail   | UBUNTU_MAINTENANCE_REBOOT_PENDING |
      When the worker is deployed
      Then the manager applied no playbook to the worker
      And the worker was converged 1 time
      And the deployment reports "ubuntu:boot-policy" as "fail", saying "UBUNTU_MAINTENANCE_REBOOT_PENDING"

    Scenario: A worker with a running agent turn is not rebooted, and the boot policy stays pending
      Given each converge reports:
        | check              | status | summary                           |
        | ubuntu:boot-policy | fail   | UBUNTU_MAINTENANCE_REBOOT_PENDING |
      And the playbook "ubuntu/reboot.yml" fails, printing "WORKER_REBOOT_BUSY"
      When the worker is deployed
      Then the worker was converged 1 time
      And the deployment reports "worker:reboot" as "warn", saying "WORKER_REBOOT_BUSY"
      And the deployment reports "ubuntu:boot-policy" as "fail", saying "UBUNTU_MAINTENANCE_REBOOT_PENDING"

    Scenario: A converge whose bootstrap failed is not rebooted
      Given each converge reports:
        | check                   | status | summary                           |
        | bootstrap:prerequisites | fail   | APT_REPOSITORY_UNAVAILABLE        |
        | ubuntu:boot-policy      | fail   | UBUNTU_MAINTENANCE_REBOOT_PENDING |
      When the worker is deployed
      Then the manager applied no playbook to the worker

  Rule: A maintenance run reboots a worker whose updates wait for a reboot

    Background:
      Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet" and the Tailscale ID "nWorkerOne"
      And the tailnet shows "nWorkerOne" with a node key that never expires
      And "worker-one" converged in an earlier run

    Scenario Outline: <flags> reboots a ready worker with pending updates
      Given the first converge reports:
        | check                 | status | summary                                                   |
        | worker:reboot-pending | warn   | REBOOT_PENDING: installed updates apply only after a reboot. |
      And each converge after it reports:
        | check                 | status | summary                  |
        | worker:reboot-pending | pass   | No reboot is pending.    |
      And the playbook "ubuntu/reboot.yml" succeeds
      When the worker is deployed with <flags>
      Then the playbook "ubuntu/reboot.yml" was applied with:
        | variable | value       |
        | reason   | maintenance |
        | force    | <force>     |
      And the worker was converged 2 times
      And the deployment reports "worker:reboot" as "pass"

      Examples:
        | flags                        | force |
        | --maintenance-reboot         | false |
        | --maintenance-reboot --force | true  |

    Scenario: Without --maintenance-reboot, pending updates only warn
      Given each converge reports:
        | check                 | status | summary                                                   |
        | worker:reboot-pending | warn   | REBOOT_PENDING: installed updates apply only after a reboot. |
      When the worker is deployed
      Then the manager applied no playbook to the worker
