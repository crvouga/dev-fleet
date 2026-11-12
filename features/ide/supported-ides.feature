Feature: Supported IDEs are reached through one interface
  Every IDE the fleet supports answers the same calls: its settings on a
  machine, the manager's own copy, and what the manager measures of a worker.
  The orchestration only knows the interface, so adding an IDE is a new
  implementation and a role, and enabling it is a line in fleet.json.

  Scenario: An IDE the orchestration has never heard of runs on every machine
    A stand-in second IDE proves that nothing outside an implementation needs
    the name of T3.
    Given a second IDE "stub" whose checks are "stub:settings", "stub:manager" and "stub:worker"
    When the fleet enables only "stub" and converges the manager and one worker
    Then these checks were reported:
      | check        |
      | stub:manager |
      | stub:worker  |
    And no check was reported by T3

  Scenario: Worker checks see what the sync reported before them
    The T3 link check waits longer after this sync restarted T3, so an IDE
    is told what the worker reported earlier.
    Given a second IDE "stub" whose checks are "stub:settings", "stub:manager" and "stub:worker"
    When the fleet enables only "stub" and converges one worker that already reported "t3:service"
    Then the IDE "stub" was told of the earlier check "t3:service"

  Scenario: The interface and the orchestration name no IDE
    When the interface and orchestration sources are read
    Then neither mentions "t3"

  Scenario: T3 is the IDE a fleet runs when it names none
    When the example fleet configuration is read
    Then the fleet runs these IDEs:
      | ide |
      | t3  |
    And the IDE "t3" is implemented

  Scenario Outline: The fleet configuration enables <ides>, which is <verdict>
    When a fleet configuration that sets ides to <ides> is read
    Then the configuration is <verdict>

    Examples:
      | ides             | verdict  |
      | ["t3"]           | accepted |
      | ["vscode"]       | refused  |
      | []               | refused  |
      | ["t3", "t3"]     | refused  |
