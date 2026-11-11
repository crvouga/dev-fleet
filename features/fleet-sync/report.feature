Feature: fleet-sync prints a short report that is the same every time
  One header line, a grid of the machines, then each problem once with its
  code and its fix. Every line is greppable: plain words when piped, the same
  with symbols and colors on a terminal.

  Background:
    Given a fleet-sync report that applied the revision "abcdef0123456789", with the dashboard "https://beszel.example.com"

  Rule: Plain output is greppable

    Scenario: A verdict, a grid of words and one line for each problem
      The same warning on two workers is printed once, naming both.
      Given the worker "w1", online and applied at no revision after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:fresh-session        | pass   | ssh:fresh-session             |              |
        | t3:service               | pass   | t3:service                    |              |
        | t3:paired-access         | fail   | MANAGER_T3_LINK_UNVERIFIED    | Pair it.     |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |
      And the worker "w2", online and applied at "abc" after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:fresh-session        | pass   | ssh:fresh-session             |              |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |
      When the report is printed in plain text, for a run of 65000 ms saved at "/r/last-sync.json"
      Then the first line printed is "fleet-sync  ACTION REQUIRED  revision abcdef012345  in 1m05s"
      And the grid printed has these lines:
        | NODE | ROLE   | NET | SSH  | OS | T3   | LINK | PROXY | AGENTS | MON | RESULT    |
        | w1   | worker | ·   | PASS | ·  | PASS | FAIL | WARN  | ·      | ·   | 1 failing |
        | w2   | worker | ·   | PASS | ·  | ·    | ·    | WARN  | ·      | ·   | ready     |
      And the printed report contains "1 failing   2 warnings   0 skipped   3 passing"
      And the printed report contains "FAIL t3:paired-access  MANAGER_T3_LINK_UNVERIFIED"
      And the printed report names "PROVIDER_UPSTREAM_UNAVAILABLE" 1 time
      And the printed report contains "    on w1, w2"
      And the printed report contains "    → Pair it."
      And the printed report contains "/r/last-sync.json"
      And the printed report has no color

    Scenario: Only stable public addresses are printed, never a tailnet address
      Given the worker "w1", online and applied at "abc" after 1000 ms, reports:
        | check      | status | summary                | remedy                                                            |
        | beszel:hub | fail   | BESZEL_HUB_UNREACHABLE | The hub is not at https://mgr.tail0a1b2c.ts.net:8443. Inspect it. |
      When the report is printed in plain text
      Then the printed report does not name "ts.net"
      And the printed report contains "its private tailnet address. Inspect it."

  Rule: Warnings alone are a converged run

    Background:
      Given the worker "w1", online and applied at "abc" after 1000 ms, reports:
        | check                    | status | summary                       | remedy       |
        | ssh:a                    | pass   | ssh:a                         |              |
        | provider:codex:inference | warn   | PROVIDER_UPSTREAM_UNAVAILABLE | Retry later. |

    Scenario: Color output adds symbols
      When the report is printed in color
      Then the printed report contains "✔ CONVERGED"
      And the printed report contains "▲"
      And the printed report has color

    Scenario: A run with no failure never prints red
      The zero count of failures is dimmed instead.
      When the report is printed in color
      Then nothing in the printed report is red
      And the printed report dims "✖ 0 failing"

  Rule: A summary is a leading code and its detail

    Scenario Outline: "<summary>" splits into the code "<code>" and the detail "<detail>"
      When the summary "<summary>" is split
      Then its code is "<code>" and its detail is "<detail>"

      Examples:
        | summary                                    | code                  | detail               |
        | SERVICE_NOT_INSTALLED beszel-agent.service | SERVICE_NOT_INSTALLED | beszel-agent.service |
        | Plain sentence.                            |                       | Plain sentence.      |
