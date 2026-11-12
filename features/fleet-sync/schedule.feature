Feature: The manager's schedule changes only when that is authorized
  The schedule is one job on the manager. Its status is read-only; enabling,
  pausing, resuming or disabling it is a change that needs "--apply --yes".
  What the platform prints never reaches the report.

  Background:
    Given a schedule request for the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" with the roster "/private/fleet.json"
    And any command would fail the scenario

  Scenario: The status is read-only and leaves out what the platform printed
    Given the platform says the schedule is installed and supported, with the detail "SECRET"
    When the schedule action "status" is requested without authorization
    Then the command exits with 0
    And the report does not mention "SECRET"

  Scenario Outline: The action "<action>" is refused without authorization
    Given a platform that can do nothing
    When the schedule action "<action>" is requested without authorization
    Then the command exits with 1

    Examples:
      | action  |
      | enable  |
      | pause   |
      | resume  |
      | disable |

  Scenario: Pausing removes only the manager's schedule, through the platform
    Given the platform removes a scheduled job it is asked to, with the detail "raw output"
    When the schedule action "pause" is requested with authorization
    Then the scheduled jobs removed are exactly:
      | personal-fleet-sync |
    And the command exits with 0
    And the report does not mention "raw output"

  Rule: The schedule runs the published package the operator runs, never a path into their project

    Scenario: Enabling installs the exact release and schedules its own entry point
      Given the CLI is the published release "1.4.0" of the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And npm installs any package it is asked to
      And the platform installs a scheduled job it is asked to
      When the schedule action "enable" is requested with authorization
      Then the command exits with 0
      And npm installed exactly "@crvouga/dev-fleet@1.4.0"
      And the scheduled job "personal-fleet-sync" runs, every 30 minutes:
        | /usr/bin/env                                                |
        | node                                                        |
        | {root}/runtime/node_modules/@crvouga/dev-fleet/bin/devfleet.mjs |
        | fleet-sync                                                  |
        | --revision                                                  |
        | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa                    |
        | --apply                                                     |
        | --yes                                                       |
        | --non-interactive                                           |
        | --json                                                      |
      And the scheduled job runs with "DEVFLEET_TRIGGER" set to "schedule"
      And the scheduled job's PATH names only the fleet's own tools and the system's
      And the fleet state records the schedule as on, every 30 minutes
      And the report does not mention "raw output"

    Scenario: A build that names no commit cannot be scheduled
      Given the CLI is the published release "1.4.0" built from no commit
      And the platform installs a scheduled job it is asked to
      When the schedule action "enable" is requested with authorization
      Then the command exits with 1
      And no command was run
      And no scheduled job was installed

    Scenario: A checkout's development version cannot be scheduled
      Given the CLI is the published release "0.0.0-development" of the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And the platform installs a scheduled job it is asked to
      When the schedule action "enable" is requested with authorization
      Then the command exits with 1
      And no scheduled job was installed

  Rule: The schedule's runs are kept, and a schedule that stopped converging fails a check

    Background:
      Given a fleet state of its own, holding no history

    Scenario: The status lists the last three scheduled runs, newest first
      Given the platform says the schedule is installed and supported, with the detail "loaded"
      And the schedule was turned on at "2026-11-01T08:00:00Z", every 30 minutes
      And fleet-sync recorded these runs:
        | finished             | trigger  | ok  | failing     |
        | 2026-11-01T09:00:00Z | schedule | yes |             |
        | 2026-11-01T09:30:00Z | schedule | no  | ssh:timeout |
        | 2026-11-01T09:40:00Z | operator | yes |             |
        | 2026-11-01T10:00:00Z | schedule | yes |             |
        | 2026-11-01T10:30:00Z | schedule | no  | tool:node   |
      When the schedule action "status" is requested without authorization
      Then the command exits with 0
      And the report has:
        | intervalSeconds         | 1800                     |
        | runs.0.finishedAt       | 2026-11-01T10:30:00.000Z |
        | runs.0.failing.0        | tool:node                |
        | runs.1.finishedAt       | 2026-11-01T10:00:00.000Z |
        | runs.2.finishedAt       | 2026-11-01T09:30:00.000Z |

    Scenario Outline: A schedule whose last success was at <last success> is checked at <now>: <outcome>
      Given the schedule was turned on at "2026-11-01T08:00:00Z", every 30 minutes
      And fleet-sync recorded these runs:
        | finished         | trigger  | ok  |
        | <last success>   | schedule | yes |
        | 2026-11-01T11:00:00Z | schedule | no  |
      When the schedule is checked at "<now>"
      Then the check "manager:schedule" <outcome>

      Examples:
        | last success         | now                  | outcome |
        | 2026-11-01T10:00:00Z | 2026-11-01T11:00:00Z | passes  |
        | 2026-11-01T10:00:00Z | 2026-11-01T11:00:01Z | fails   |
        | 2026-11-01T08:30:00Z | 2026-11-01T11:00:00Z | fails   |

    Scenario: A schedule turned on a moment ago has not failed yet
      Given the schedule was turned on at "2026-11-01T10:00:00Z", every 30 minutes
      When the schedule is checked at "2026-11-01T10:45:00Z"
      Then the check "manager:schedule" passes

    Scenario: A schedule that never succeeded since it was turned on fails after two intervals
      Given the schedule was turned on at "2026-11-01T10:00:00Z", every 30 minutes
      When the schedule is checked at "2026-11-01T11:00:01Z"
      Then the check "manager:schedule" fails

    Scenario: A schedule that is off, or was never turned on, is not checked
      Given the schedule was turned off at "2026-11-01T08:00:00Z", every 30 minutes
      When the schedule is checked at "2026-11-02T08:00:00Z"
      Then there is no schedule check

  Rule: How often the schedule runs is set in the fleet configuration

    Scenario: The schedule runs as often as the fleet configuration says
      Given the CLI is the published release "1.4.0" of the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And npm installs any package it is asked to
      And the platform installs a scheduled job it is asked to
      And the fleet configuration sets the manager's schedule to:
        """
        { "syncMinutes": 45 }
        """
      When the schedule action "enable" is requested with authorization
      Then the command exits with 0
      And the scheduled job "personal-fleet-sync" runs every 45 minutes
      And the fleet state records the schedule as on, every 45 minutes

    Scenario Outline: An interval of <minutes> minutes is refused
      When a fleet configuration that sets the manager's schedule to { "<job>": <minutes> } is read
      Then reading it fails at "$.manager.schedule.<job>"

      Examples:
        | job          | minutes |
        | syncMinutes  | 4       |
        | watchMinutes | 1441    |
        | syncMinutes  | 7.5     |

  Rule: The logs of the manager's scheduled jobs stay under a fixed size
    newsyslog rotates them, from the drop-in the manager's one grant
    (ansible/macos/manager-privilege.yml) installs, at the size jobLogs in
    ansible/macos/policy.json names. manager:job-logs measures both.

    Scenario: The grant rotates each log of both scheduled jobs at the size the policy names
      When the newsyslog drop-in of "ansible/macos/manager-privilege.yml" is read for the user "dev"
      Then it rotates exactly these logs under "/Users/dev/.local/share/personal/fleet/manager/logs", at 1024 KiB, keeping 3:
        | personal-fleet-sync.out.log      |
        | personal-fleet-sync.err.log      |
        | dev.devfleet.fleet-watch.out.log |
        | dev.devfleet.fleet-watch.err.log |
      And it is checked with newsyslog before it is installed

    Scenario: Logs under the rotation size pass
      Given the newsyslog drop-in for the manager's job logs is installed
      And the job log "personal-fleet-sync.out.log" holds 1500 KiB of lines
      When the manager's job logs are checked
      Then the check "manager:job-logs" passes

    Scenario: A log past twice the rotation size warns that newsyslog does not rotate it
      Given the newsyslog drop-in for the manager's job logs is installed
      And the job log "dev.devfleet.fleet-watch.err.log" holds 2100 KiB of lines
      When the manager's job logs are checked
      Then the check "manager:job-logs" warns with "MANAGER_JOB_LOG_OVERSIZED 1 logs"

    Scenario: A manager without the drop-in is told to give the grant
      When the manager's job logs are checked
      Then the check "manager:job-logs" warns with "MANAGER_JOB_LOG_ROTATION_MISSING"
      And the remedy of the check "manager:job-logs" names "ansible/macos/manager-privilege.yml"
