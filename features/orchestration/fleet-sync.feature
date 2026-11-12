Feature: fleet-sync converges every worker on one approved revision
  One run of fleet-sync uses one revision. The manager first inspects every
  worker the fleet configuration names, then deploys to those it may. A worker
  it cannot reach, or whose device changed, stays in the report: nothing is
  left out silently, and a computer that is merely on the tailnet is never
  deployed to.

  Background:
    Given a fleet configuration with these workers:
      | id     | ssh    | os    |
      | first  | first  | linux |
      | second | second | linux |
    And the manager has these workers registered:
      | id     | ssh    | workspace        | tailscale id |
      | first  | first  | /home/dev/first  | first        |
      | second | second | /home/dev/second | second       |
    And the tailnet shows these computers:
      | tailscale id | name       | dns                       | address    | online | this manager |
      | manager      | manager    | manager.example.ts.net    | 100.64.0.1 | yes    | yes          |
      | first        | first      | first.example.ts.net      | 100.64.0.1 | yes    | no           |
      | second       | second     | second.example.ts.net     | 100.64.0.1 | yes    | no           |
      | unapproved   | unapproved | unapproved.example.ts.net | 100.64.0.1 | yes    | no           |
    And every SSH alias resolves to its own name in the tailnet "example.ts.net"
    And every worker answers a fresh SSH session as "ubuntu" "26.04" on "x86_64", running on a "machine"
    And the approved revision is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: One run deploys one revision, and never to a computer the fleet does not name
    Given deploying a worker reports these checks:
      | id       | status | summary |
      | verified | pass   | fixture |
    When fleet-sync applies the approved revision
    Then the revision was deployed to these workers, in order:
      | first  |
      | second |
    And every deployment was of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And the report counts 1 computer on the tailnet that is no worker of the fleet
    And the report covers, in order:
      | first  |
      | second |

  Scenario: An offline worker stays in the report while a reachable one is deployed
    Given "second" is offline in the tailnet
    And deploying a worker reports these checks:
      | id   | status | summary |
      | done | pass   | fixture |
    When fleet-sync applies the approved revision
    Then the revision was deployed to these workers, in order:
      | first |
    And the report covers, in order:
      | first  |
      | second |
    And the report shows "second" as "offline"
    And the fleet is not ready

  Scenario Outline: A worker that answers from <environment> is reported and never deployed
    Given every worker answers a fresh SSH session as "ubuntu" "26.04" on "x86_64", running on a "<environment>"
    And deploying a worker reports these checks:
      | id   | status | summary |
      | done | pass   | fixture |
    When fleet-sync applies the approved revision
    Then the revision was deployed to no worker
    And every worker has a check that says "WORKER_ENVIRONMENT_UNSUPPORTED: <named>"
    And the fleet is not ready

    Examples:
      | environment | named     |
      | wsl         | WSL2      |
      | container   | container |

  Scenario: A failed canary stops promotion, and the workers after it are still inspected
    What a failed deployment threw may hold anything, so it is never reported.
    Given deploying a worker fails with the error "secret detail"
    When fleet-sync applies the approved revision with "first" as its canary
    Then the revision was deployed to these workers, in order:
      | first |
    And the report covers, in order:
      | first  |
      | second |
    And the checks of "second" include "ssh:fresh-session"
    And the last check of "second" says "FLEET_PROMOTION_BLOCKED"
    And "secret detail" appears nowhere in what is reported

  Scenario: A run that does not select the declared canary proves the revision on the first worker it selects
    Narrowing a run to some workers never promotes a new revision without a
    canary.
    Given deploying a worker reports these checks:
      | id              | status | summary                    |
      | ubuntu:baseline | fail   | UBUNTU_BASELINE_INCOMPLETE |
    When fleet-sync applies the approved revision with "retired" as its canary
    Then the revision was deployed to these workers, in order:
      | first |
    And the last check of "second" says "FLEET_PROMOTION_BLOCKED"

  Scenario: An offline canary hands the proof to the next reachable worker
    A worker that is powered off or being rebuilt is reported as offline, not
    as a blocked rollout: workers are cattle, and no single one stops the
    fleet from being updated.
    Given "first" is offline in the tailnet
    And deploying a worker reports these checks:
      | id   | status | summary |
      | done | pass   | fixture |
    When fleet-sync applies the approved revision with "first" as its canary
    Then the revision was deployed to these workers, in order:
      | second |
    And the report names "second" as the canary
    And the report shows "first" as "offline"
    And no check of "first" says "FLEET_PROMOTION_BLOCKED"
    And "second" holds the approved revision
    And the fleet is not ready

  Scenario: A named canary that is reachable proves the revision first
    Given deploying a worker reports these checks:
      | id   | status | summary |
      | done | pass   | fixture |
    When fleet-sync applies the approved revision with "second" as its canary
    Then the revision was deployed to these workers, in order:
      | second |
      | first  |
    And the report names "second" as the canary

  Scenario: A preview deploys nothing, and a worker the manager has not registered is still accounted for
    Given the manager has no registration for "second"
    And deploying a worker fails with the error "must not deploy"
    When fleet-sync previews the approved revision
    Then the report covers, in order:
      | first  |
      | second |
    And the first check of "second" says "FLEET_CONNECTION_REQUIRED"
    And nothing was applied
    And the revision was deployed to no worker

  Scenario: A replaced device blocks every write, even when SSH succeeds
    Given every registration records the tailscale id "old"
    And deploying a worker fails with the error "must not deploy"
    When fleet-sync applies the approved revision
    Then nothing was applied
    And every worker has a check that says "TAILSCALE_DEVICE_REPLACED"

  Scenario: A worker authorized for bootstrap over a trusted SSH route is deployed while it is offline
    The run still is not ready: nothing fresh from the tailnet says the worker
    is reachable.
    Given every registration authorizes bootstrap over SSH
    And "second" is offline in the tailnet
    And deploying a worker reports these checks:
      | id            | status | summary                                      |
      | fixture:apply | pass   | Applied; no fresh tailnet evidence supplied. |
    When fleet-sync applies the approved revision
    Then the revision was deployed to these workers, in order:
      | first  |
      | second |
    And the fleet is not ready
    And the report covers, in order:
      | first  |
      | second |
    And the report shows "second" as "offline"

  Scenario: Authorization to bootstrap over SSH never admits a changed device
    Given every registration authorizes bootstrap over SSH
    And every registration records the tailscale id "replaced"
    And deploying a worker fails with the error "must not deploy"
    When fleet-sync applies the approved revision
    Then nothing was applied

  Scenario: A missing monitoring account or client pairing leaves a worker incomplete without stopping the others
    Given deploying a worker reports these checks:
      | id                | status | summary                        |
      | beszel:enrollment | fail   | BESZEL_ACCOUNT_REQUIRED        |
      | t3:end-to-end     | skip   | REQUIRED_ACCEPTANCE_UNVERIFIED |
    When fleet-sync applies the approved revision with "first" as its canary
    Then the revision was deployed to these workers, in order:
      | first  |
      | second |
    And the fleet is not ready
    And no worker is recorded as having the revision applied

  Scenario: Warnings and skips are reported, and a run in which nothing failed is ready
    Given deploying a worker reports these checks:
      | id                         | status | summary                       |
      | configuration:apply        | pass   | ok                            |
      | provider:codex:inference   | warn   | PROVIDER_UPSTREAM_UNAVAILABLE |
      | worker:power-loss-recovery | skip   | unobservable                  |
    When fleet-sync applies the approved revision
    Then the fleet is ready
    And these workers are recorded as having these revisions applied:
      | worker | revision                                 |
      | first  | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
      | second | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
    And these workers were announced as finished, in order:
      | first  |
      | second |

  Rule: A maintenance run goes one worker at a time, canary first

    Scenario: A worker a reboot left unready stops the workers after it
      A check that never stops promotion on its own (T3's end-to-end test)
      does once the worker was rebooted: it is not back to ready.
      Given deploying "first" reports these checks:
        | id             | status | summary                       |
        | worker:reboot  | pass   | Rebooted for maintenance      |
        | t3:end-to-end  | fail   | T3_PRIVATE_ROUTE_UNVERIFIED   |
      And deploying "second" reports these checks:
        | id   | status | summary |
        | done | pass   | fixture |
      When fleet-sync applies the approved revision with "first" as its canary, one worker at a time
      Then the revision was deployed to these workers, in order:
        | first |
      And the last check of "second" says "FLEET_PROMOTION_BLOCKED"

    Scenario: A worker that came back ready lets the next one go
      Given deploying "first" reports these checks:
        | id            | status | summary                  |
        | worker:reboot | pass   | Rebooted for maintenance |
      And deploying "second" reports these checks:
        | id            | status | summary                  |
        | worker:reboot | pass   | Rebooted for maintenance |
      When fleet-sync applies the approved revision with "second" as its canary, one worker at a time
      Then the revision was deployed to these workers, in order:
        | second |
        | first  |
      And the fleet is ready

    Scenario: A worker left alone because an agent turn runs does not stop the others
      Given deploying "first" reports these checks:
        | id            | status | summary            |
        | worker:reboot | warn   | WORKER_REBOOT_BUSY |
      And deploying "second" reports these checks:
        | id   | status | summary |
        | done | pass   | fixture |
      When fleet-sync applies the approved revision with "first" as its canary, one worker at a time
      Then the revision was deployed to these workers, in order:
        | first  |
        | second |
