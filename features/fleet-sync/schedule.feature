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
