Feature: A verified check is reused while nothing changed
  Proving an inference route or an agent session takes a real request to a
  provider. A pass is remembered with a key made of everything it depends
  on, and reused until the key changes or the pass ages out. Only a clean
  pass is remembered: after a failure the next sync verifies again.

  Background:
    Given a verified pass is remembered for 6 hours

  Scenario: A pass is reused while its key is unchanged and fresh
    Given the check "x" passed with the key "k1" at 0 ms
    When it is verified again with the key "k1" at 60000 ms
    Then it has been verified 1 time in all
    And the result passes
    And the summary of the result contains "verified 1m ago"

  Scenario Outline: A check is verified again when <reason>
    Given the check "<check>" <outcome> with the key "<key>" at <at> ms
    When it is verified again with the key "<next key>" at <next> ms
    Then it has been verified 2 times in all

    Examples:
      | reason              | check | outcome | key | at | next key | next     |
      | its key changed     | x     | passed  | k1  | 0  | k2       | 1        |
      | it is six hours old | x     | passed  | k2  | 1  | k2       | 21600001 |
      | it failed           | y     | failed  | k   | 0  | k        | 1        |

  Scenario: A check is verified again when what is remembered is to be ignored
    A live probe failed, or a full check was asked for.
    Given the check "x" passed with the key "k2" at 21600001 ms
    When it is verified again with the key "k2" at 21600002 ms, ignoring what is remembered
    Then it has been verified 2 times in all

  Scenario: A pass the caller marks not reusable is never remembered
    A pass that only says the account is out of quota proves nothing about
    the next request.
    Given the check "q" passed with the key "k" at 0 ms, as a pass that must not be reused
    When it is verified again with the key "k" at 0 ms
    Then it has been verified 2 times in all
