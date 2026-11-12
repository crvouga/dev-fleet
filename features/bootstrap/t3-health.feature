Feature: The watchdog keeps a worker's T3 up, responsive and on its installed release
  Every minute on a worker: a T3 that is stopped or failed is started. One
  that runs but whose local API has not answered for three checks in a row
  is restarted, since a hung server serves no turns. One that runs another
  release than the installed one, or has not loaded a staged policy, is
  restarted once it runs no agent turn.

  Scenario: A stopped service has its start limit reset and is started
    A unit that hit its start limit would otherwise refuse every start.
    Given the T3 desktop service is stopped
    And T3 does not answer its health check
    When the watchdog runs
    Then it exits with 0
    And it runs "systemctl --user reset-failed t3code-desktop.service" before "systemctl --user start t3code-desktop.service"

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
      Then it runs "systemctl --user reset-failed t3code-desktop.service" before "systemctl --user restart t3code-desktop.service"

  Rule: The former headless server is retired, then the desktop app recovered
    One T3 runs on a worker. A headless server still there is stopped and
    disabled, and the desktop app gets the same recovery as anywhere else.

    Scenario: A worker that still runs the headless server ends with the desktop app started
      Given the headless T3 server is running
      And the T3 desktop service is stopped
      When the watchdog runs
      Then it exits with 0
      And it runs "systemctl --user disable --now t3code.service" before "systemctl --user start t3code-desktop.service"

    Scenario: A headless server that cannot be stopped is reported and nothing is started next to it
      Given the headless T3 server is running
      And the headless T3 server cannot be stopped
      And the T3 desktop service is stopped
      When the watchdog runs
      Then it exits with 1
      And it says "T3_LEGACY_SERVER_RUNNING"
      And it starts and restarts nothing

  Rule: Without a graphical session the display manager is restarted, a bounded number of times
    The desktop app needs the auto-login graphical session. Three checks in a
    row without one restart the display manager so auto-login starts one;
    after three such restarts a person must log in.

    Background:
      Given there is no graphical session
      And the T3 desktop service is stopped

    Scenario: A missing session is reported and the app is not started into nothing
      When the watchdog runs
      Then it exits with 1
      And it says "T3_NO_GRAPHICAL_SESSION"
      And it starts and restarts nothing

    Scenario: The third check without a session restarts the display manager
      Given the watchdog has run 2 times
      When the watchdog runs
      Then it runs "sudo -n systemctl restart display-manager.service"

    Scenario: The display manager is restarted three times at most
      When the watchdog runs 15 times
      Then it ran "sudo -n systemctl restart display-manager.service" 3 times

  Rule: A restart that ends agent turns waits until T3 runs none

    Background:
      Given the T3 desktop service is running

    Scenario: A T3 still running the previous release is restarted once it is idle
      Given T3 answers its health check as release "0.1.8"
      And the installed release is "0.1.9"
      And T3 runs no agent turn
      When the watchdog runs
      Then it runs "systemctl --user restart t3code-desktop.service"

    Scenario: A T3 still running the previous release keeps its running turns
      Given T3 answers its health check as release "0.1.8"
      And the installed release is "0.1.9"
      And T3 runs an agent turn
      When the watchdog runs
      Then it exits with 0
      And it says "T3_RESTART_PENDING"
      And it has restarted nothing

    Scenario: A T3 that still runs another release after its restart is not restarted again
      Given T3 answers its health check as release "0.1.8"
      And the installed release is "0.1.9"
      And the watchdog has run 1 time
      When the watchdog runs
      Then it exits with 1
      And it says "T3_RUNNING_VERSION_MISMATCH"
      And it ran "systemctl --user restart t3code-desktop.service" 1 times

    Scenario: A T3 on the installed release is left alone
      Given T3 answers its health check as release "0.1.9"
      And the installed release is "0.1.9"
      When the watchdog runs
      Then it starts and restarts nothing

    Scenario: A policy restart deferred while turns ran is applied once T3 is idle
      Given T3 answers its health check as release "0.1.9"
      And the installed release is "0.1.9"
      And a restart for the staged policy is pending
      And T3 runs no agent turn
      When the watchdog runs
      Then it runs "systemctl --user restart t3code-desktop.service"
      And the pending restart is cleared

    Scenario: A policy restart stays pending while an agent turn runs
      Given T3 answers its health check as release "0.1.9"
      And the installed release is "0.1.9"
      And a restart for the staged policy is pending
      And T3 runs an agent turn
      When the watchdog runs
      Then it says "T3_RESTART_PENDING"
      And it has restarted nothing
      And the pending restart is kept

  Rule: A headless worker's server is recovered the same way, with no session to wait for
    A headless worker (fleet.json features.session "headless") runs the
    pinned T3 server as a lingering user service, t3code-headless.service.
    Nobody logs in to it, so a missing graphical session is not a fault: the
    server is started, restarted and moved to its installed release like the
    desktop app. The installed release is the versioned directory its unit
    runs the server from.

    Scenario: A killed server is started at the next check, with nobody logged in
      Given the T3 server of the headless session is stopped
      And there is no graphical session
      And T3 does not answer its health check
      When the watchdog runs
      Then it exits with 0
      And it runs "systemctl --user reset-failed t3code-headless.service" before "systemctl --user start t3code-headless.service"
      And it does not run "sudo -n systemctl restart display-manager.service"
      And it does not run "systemctl --user start t3code-desktop.service"

    Scenario: An unresponsive server is restarted after three failed checks
      Given the T3 server of the headless session is running
      And there is no graphical session
      And T3 does not answer its health check
      And the watchdog has run 2 times
      When the watchdog runs
      Then it runs "systemctl --user reset-failed t3code-headless.service" before "systemctl --user restart t3code-headless.service"

    Scenario: A server still running the previous release is restarted once it is idle
      Given the T3 server of the headless session is running
      And there is no graphical session
      And the installed release is "0.1.8"
      And T3 answers its health check as release "0.1.7"
      And T3 runs no agent turn
      When the watchdog runs
      Then it runs "systemctl --user restart t3code-headless.service"
