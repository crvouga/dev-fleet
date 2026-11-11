Feature: A report says what was checked on every machine
  A command ends with one report: the checks of each machine and how many
  passed, warned, failed or were skipped. A warning or a skip is shown and
  counted; it fails a run only when the operator asked for a strict one.

  Rule: A failed check fails a run; a warning or a skip fails only a strict one

    Scenario: Warnings and skips are counted and do not fail an ordinary run
      Given the worker "first" has these checks:
        | id    | status | summary    |
        | one   | pass   | passed     |
        | two   | warn   | unverified |
        | three | skip   | not run    |
      When the "doctor" report is made
      Then the report counts:
        | pass | 1 |
        | warn | 1 |
        | skip | 1 |
        | fail | 0 |
      And the run exits with 0
      But a strict run exits with 1

    Scenario: A failed check fails a run
      Given the worker "bad" has these checks:
        | id     | status | summary |
        | broken | fail   | failed  |
      When the "doctor" report is made
      Then the run exits with 1

  Rule: Workers are probed a bounded number at a time, and answer in the order they were asked

    Scenario: Five probes run two at a time
      Given probes of workers that take these milliseconds:
        | 5 | 4 | 3 | 2 | 1 |
      When they are run 2 at a time, each answering twice its milliseconds
      Then the answers are, in this order:
        | 10 | 8 | 6 | 4 | 2 |
      And the most that ran at once was 2

  Rule: Only the fields of the protocol are read from what a worker sends

    Scenario: A snapshot is read field by field, so nothing else a worker sent is repeated
      When the manager decodes this snapshot from a worker:
        """
        {
          "version": 1,
          "platform": "linux",
          "token": "never-print-this",
          "fingerprint": {
            "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "files": {},
            "password": "never-print-this"
          },
          "checks": [
            {
              "id": "example",
              "status": "pass",
              "summary": "safe",
              "private": "never-print-this",
              "remedy": { "action": "safe", "token": "never-print-this" }
            }
          ]
        }
        """
      Then the snapshot is accepted, with the version 1
      And nothing reported contains "never-print-this"
