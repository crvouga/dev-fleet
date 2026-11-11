Feature: The watchdog keeps a worker's T3 up and responsive
  Every minute on a worker: a T3 that is stopped or failed is started. One
  that runs but whose local API has not answered for three checks in a row
  is restarted, since a hung server serves no turns.

  Scenario: A stopped service is started
    Given the T3 desktop service is stopped
    And T3 does not answer its health check
    When the watchdog runs
    Then it exits with 0
    And it runs "systemctl --user start t3code-desktop.service"

  Scenario: A healthy service is left alone
    Given the T3 desktop service is running
    And T3 answers its health check
    When the watchdog runs
    Then it starts and restarts nothing

  Rule: An unresponsive service is restarted only after three failed checks

    Background:
      Given the T3 desktop service is running
      But T3 does not answer its health check

    Scenario: A second failed check in a row restarts nothing
      Given the watchdog has run 1 time
      When the watchdog runs
      Then it has restarted nothing

    Scenario: The third failed check in a row restarts the service
      Given the watchdog has run 2 times
      When the watchdog runs
      Then it runs "systemctl --user restart t3code-desktop.service"

  Rule: Nothing is started while the headless server still runs
    The former headless server runs until its approved migration; a second
    T3 is never started next to it.

    Scenario: A worker that still runs the headless server is left as it is
      Given the headless T3 server is running
      And the T3 desktop service is stopped
      And T3 does not answer its health check
      When the watchdog runs
      Then it exits with 0
      And it starts and restarts nothing
