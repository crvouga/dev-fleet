Feature: A worker's T3 is idle only when it runs no agent turn
  A restart ends every running turn, so T3 is restarted only while it runs
  none. T3 has no command that lists the running turns of every project; the
  runs it records in its own state database are read, and nothing in it is
  changed. Anything that cannot be read counts as busy.

  Scenario Outline: A T3 whose runs are <runs> is <answer>
    Given T3 has recorded runs with these statuses:
      | <first>  |
      | <second> |
    When T3 is asked whether it runs an agent turn
    Then it exits with <exit>

    Examples:
      | runs                     | first     | second      | answer | exit |
      | all completed            | completed | completed   | idle   | 0    |
      | completed or interrupted | completed | interrupted | idle   | 0    |
      | one still running        | completed | running     | busy   | 1    |

  Scenario: A database T3 keeps no runs in counts as busy
    Given T3 keeps its state in a database without runs
    When T3 is asked whether it runs an agent turn
    Then it exits with 2
    And the answer says "T3_IDLE_UNKNOWN"
