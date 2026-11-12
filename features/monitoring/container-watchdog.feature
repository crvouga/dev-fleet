@agent-box @slow @linux
Feature: A container frozen while it holds its port is restarted by the watchdog
  Docker restarts a container that exits, never one that hangs. The watchdog
  the manager runs restarts a labelled container its healthcheck reports
  unhealthy, at most a few times an hour. Here a real container is frozen with
  SIGSTOP, so it keeps its port and answers nothing, like a hung CLI proxy.
  Runs only when DEVFLEET_TEST_AGENT_BOX is set, because it needs Docker.

  Background:
    Given a labelled container that serves HTTP and checks its health every second

  Scenario: A frozen container is restarted and healthy again within the documented time
    Given the container was frozen with SIGSTOP
    And Docker reports the container unhealthy
    When the watchdog runs every second, restarting after 2 unhealthy checks, for at most 60 seconds
    Then the watchdog restarted the container
    And the container is running and healthy again

  Scenario: A container that keeps hanging is left alone once the hourly cap is reached
    Given the watchdog already restarted the container 3 times in the last hour
    And the container was frozen with SIGSTOP
    And Docker reports the container unhealthy
    When the watchdog runs every second, restarting after 2 unhealthy checks, for at most 10 seconds
    Then the watchdog did not restart the container, and recorded it as capped
