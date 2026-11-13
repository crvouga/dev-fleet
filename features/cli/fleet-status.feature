Feature: fleet-status checks the manager and its workers without changing them
  The manager is always checked. Workers are reached over SSH and run the
  probe the manager sends them; nothing is installed on a worker to check it.

  Background:
    Given a workspace with its dependency files and no roster
    And every command on this manager succeeds
    And a command with the argument "rev-parse" prints "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: Checking this manager only bundles no probe and asks no login it was not asked about
    When the operator runs "devfleet fleet-status --local --require none"
    Then the report covers exactly "manager"
    And in the answer, "coverage.scope" is "local"
    And only these programs were run:
      | git     |
      | ssh-add |
    And no probe was bundled for workers

  Scenario: A schedule that has not converged the fleet for two of its intervals fails the manager's check
    The schedule keeps the fleet converged without anyone running fleet-sync,
    so a schedule that silently stopped working is a failure, not a detail.
    Given the fleet state records a schedule turned on at "2026-01-01T00:00:00Z", every 30 minutes, that never succeeded
    When the operator runs "devfleet fleet-status --local --require none"
    Then it exits with 1
    And the check "manager:schedule" has the status "fail"

  Scenario: Without a roster the manager is still checked, and the fleet is reported as unknown
    When the operator runs "devfleet fleet-status --all --require none"
    Then it exits with 1
    And the report covers "manager"
    And the check "fleet:roster" has the status "fail"
    And no probe was bundled for workers

  Rule: From the published package, everything is measured against the fleet-owned checkout of the commit it names
    The installed package holds no Git history and no bun.lock, and the
    repository around it is the operator's project. fleet-sync makes a
    fleet-owned checkout of the package's commit on the manager; fleet-status
    checks the manager in it and compares every worker with it.

    Background:
      Given devfleet runs from a package published from the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: The manager is checked in its checkout of the package's commit, not in the package
      Given the manager has its fleet-owned checkout of that commit
      When the operator runs "devfleet fleet-status --local --require none"
      Then the check "workspace" of "manager" has the status "pass"
      And Git was run only in the fleet-owned checkout

    Scenario: A worker at the package's commit matches it, lockfiles included
      Given the manager has its fleet-owned checkout of that commit
      And these workers are registered:
        | id  | ssh     | workspace           |
        | one | dev-one | /home/dev/workspace |
      And the probe sent to workers is "standalone-probe-source"
      And every worker answers the probe as the fleet-owned checkout does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When the operator runs "devfleet fleet-status --require none"
      Then the check "revision" of "one" has the status "pass"
      And the check "sync:bun.lock" of "one" has the status "pass"
      And the check "sync:package.json" of "one" has the status "pass"

    Scenario: Before fleet-sync has made the checkout, fleet-status says to run it
      When the operator runs "devfleet fleet-status --local --require none"
      Then the check "workspace" of "manager" has the status "fail"
      And the check "workspace" of "manager" says "no fleet-owned checkout of the commit this package names"

  Rule: Workers are reached over SSH with the probe the manager supplies

    Background:
      Given these workers are registered:
        | id  | ssh     | workspace           |
        | one | dev-one | /home/dev/workspace |
        | two | dev-one | /home/dev/workspace |
      And the probe sent to workers is "standalone-probe-source"
      And every worker answers the probe as this workspace does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: With no scope named, every registered worker is checked
      When the operator runs "devfleet fleet-status --require none"
      Then the report covers exactly "manager, one, two"
      And 2 commands were run over SSH
      And every command run over SSH was given the probe "standalone-probe-source"

    Scenario: --node limits SSH to the worker it names
      When the operator runs "devfleet fleet-status --node two --require none"
      Then the report covers exactly "manager, two"
      And 1 command was run over SSH
      And every command run over SSH was given the probe "standalone-probe-source"

  Rule: Each worker is listed as parked or active, with what an active one is doing
    A rented worker costs money while it runs. fleet-status says, for every
    worker it reaches, how long it has been up, how many agent turns run on
    it and when an agent last did something (from T3, never the content of
    a session), and adds what fleet.json declares the idle ones cost.

    Background:
      Given these workers are registered:
        | id         | ssh        | workspace           |
        | worker-one | worker-one | /home/dev/workspace |
        | worker-two | worker-two | /home/dev/workspace |
      And the probe sent to workers is "standalone-probe-source"
      And every worker answers the probe as this workspace does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And fleet.json declares that a worker is idle after 12 hours, and these hourly rates:
        | worker-one | 0.5 USD |
        | worker-two | 1.5 USD |

    Scenario: A parked worker is listed as parked, is not contacted and fails nothing
      Given the fleet state records "worker-two" as parked at "2026-11-01T00:00:00.000Z"
      And the T3 of "worker-one" runs 1 agent turn, its last agent activity was at "2026-11-01T00:00:00.000Z", and it is up 7200 seconds
      When the operator runs "devfleet fleet-status --strict --require none"
      Then every check of "worker-two" is not applicable, which fails nothing even under --strict
      And workers were probed 1 time
      And the check "worker:parked" has the status "not-applicable"
      And the check "worker:parked" of "worker-two" says "worker-two is parked since 2026-11-01T00:00:00.000Z"
      And in the answer, the worker "worker-two" has:
        | state    | "parked"                   |
        | parkedAt | "2026-11-01T00:00:00.000Z" |

    Scenario: The answer carries uptime, agent turns and last activity for every reachable worker
      Given the T3 of "worker-one" runs 1 agent turn, its last agent activity was at "2026-11-01T00:00:00.000Z", and it is up 7200 seconds
      And the T3 of "worker-two" runs 0 agent turns, its last agent activity was at "2026-11-01T00:00:00.000Z", and it is up 90000 seconds
      When the operator runs "devfleet fleet-status --require none"
      Then in the answer, the worker "worker-one" has:
        | state           | "active"                   |
        | uptimeSeconds   | 7200                       |
        | runningSessions | 1                          |
        | lastActivityAt  | "2026-11-01T00:00:00.000Z" |
        | idle            | false                      |
      And in the answer, the worker "worker-two" has:
        | state           | "active"                   |
        | uptimeSeconds   | 90000                      |
        | runningSessions | 0                          |
        | lastActivityAt  | "2026-11-01T00:00:00.000Z" |
        | idle            | true                       |
      And the check "worker:idle" of "worker-two" says "has run no agent turn for"
      And the check "worker:idle" of "worker-two" says "longer than the declared 12h"
      And the check "worker:idle" of "worker-one" says "worker-one runs 1 agent turn(s)"
      And in the answer, the usage is:
        | running        | 2     |
        | idle           | 1     |
        | parked         | 0     |
        | idleCostPerDay | 36    |
        | currency       | "USD" |

  Rule: A device tagged as a worker that no declared worker accounts for is a leftover
    A rebuilt or abandoned rented machine can stay on the tailnet, carrying
    the fleet's worker tag. fleet-status asks the control plane fleet.json
    declares for every device with the tag and warns of each one that is no
    declared worker (parked ones included) and no device the roster binds.
    It names the device by its name only.

    Background:
      Given these workers are registered:
        | id         | ssh        | workspace           |
        | worker-one | worker-one | /home/dev/workspace |
        | worker-two | worker-two | /home/dev/workspace |
      And the probe sent to workers is "standalone-probe-source"
      And every worker answers the probe as this workspace does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: A device joined by hand with the worker tag shows up in fleet-status
      Given fleet.json declares the hosted Tailscale as its control plane, tagging workers "tag:fleet-worker"
      And the control plane lists these devices:
        | id      | name        | tags             |
        | nOne    | worker-one  | tag:fleet-worker |
        | nTwo    | worker-two  | tag:fleet-worker |
        | nByHand | scratch-box | tag:fleet-worker |
        | nLaptop | laptop      | tag:personal     |
      When the operator runs "devfleet fleet-status --require none"
      Then fleet-status warns of exactly these leftover devices:
        | scratch-box |
      And the check "tailscale:leftover" of "tailnet" says "tagged tag:fleet-worker, which is no declared worker"

    Scenario: Without a tailnet control plane nothing is asked and nothing is reported
      Given fleet.json declares no tailnet control plane
      When the operator runs "devfleet fleet-status --require none"
      Then fleet-status reports no leftover device
      And the control plane was asked nothing
