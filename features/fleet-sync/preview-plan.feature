Feature: fleet-sync --dry-run says what a sync would change, and changes nothing
  The preview starts from the fleet state as the bucket holds it, then plans
  from the revision the fleet last applied to the one selected: which tool
  pins change, and what restarts because of them. The plan is read from Git
  and is part of the --json report.

  Rule: The plan lists exactly what changes between the two revisions

    Background:
      Given the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" pins, in its mise.toml:
        """
        [tools]
        node = "26.13.0"
        claude = "2.1.314"
        gemini = { version = "0.66.0", allow_builds = ["@lydell/node-pty"] }

        [vars]
        t3_version = "0.1.8-nightly.20261106.4262"
        """

    Scenario: One pending bump of an agent CLI is listed alone, and ends no running turn
      Given the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" pins, in its mise.toml:
        """
        [tools]
        node = "26.13.0"
        claude = "2.1.315"
        gemini = { version = "0.66.0", allow_builds = ["@lydell/node-pty"] }

        [vars]
        t3_version = "0.1.8-nightly.20261106.4262"
        """
      And between "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" these files change:
        | mise.toml |
        | mise.lock |
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is made for the machines "manager, worker-one"
      Then the plan lists exactly these tool changes:
        | tool   | from    | to      |
        | claude | 2.1.314 | 2.1.315 |
      And the plan restarts exactly:
        | service    | ends running turns |
        | agent-clis | no                 |
      And the plan moves these machines from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        | manager    |
        | worker-one |
      And the plan prints:
        """
        Plan: aaaaaaaaaaaa → bbbbbbbbbbbb on manager, worker-one.
          claude 2.1.314 → 2.1.315
          Restarts agent-clis: New sessions use the new claude; running turns keep the version they started with.
        """

    Scenario: A pending T3 bump restarts T3 once it is idle, so no running agent turn ends
      A worker's T3 restarts only while it runs no agent turn; a busy one
      keeps its turns and the restart stays pending until it is idle.
      Given the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" pins, in its mise.toml:
        """
        [tools]
        node = "26.13.0"
        claude = "2.1.314"
        gemini = { version = "0.66.0", allow_builds = ["@lydell/node-pty"] }

        [vars]
        t3_version = "0.1.9"
        """
      And between "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" these files change:
        | mise.toml |
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is made for the machines "worker-one"
      Then the plan lists exactly these tool changes:
        | tool | from                        | to    |
        | t3   | 0.1.8-nightly.20261106.4262 | 0.1.9 |
      And the plan restarts exactly:
        | service | ends running turns |
        | t3      | no                 |
      And the plan prints:
        """
        Plan: aaaaaaaaaaaa → bbbbbbbbbbbb on worker-one.
          t3 0.1.8-nightly.20261106.4262 → 0.1.9
          Restarts t3: T3 is upgraded on every worker and restarted once it runs no agent turn: running turns keep going and the restart is pending until then.
        """

    Scenario: With --restart-busy, the plan says that running agent turns end
      Given the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" pins, in its mise.toml:
        """
        [tools]
        node = "26.13.0"
        claude = "2.1.314"
        gemini = { version = "0.66.0", allow_builds = ["@lydell/node-pty"] }

        [vars]
        t3_version = "0.1.9"
        """
      And between "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" these files change:
        | mise.toml |
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is made for the machines "worker-one", restarting a busy T3
      Then the plan restarts exactly:
        | service | ends running turns |
        | t3      | yes                |
      And the plan prints:
        """
        Plan: aaaaaaaaaaaa → bbbbbbbbbbbb on worker-one.
          t3 0.1.8-nightly.20261106.4262 → 0.1.9
          Restarts t3: T3 is upgraded on every worker and restarted at once (--restart-busy): its running agent turns end.
        """

    Scenario: A change to T3's managed policy may restart T3 once it is idle, even with no tool bump
      Given the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" pins, in its mise.toml:
        """
        [tools]
        node = "26.13.0"
        claude = "2.1.314"
        gemini = { version = "0.66.0", allow_builds = ["@lydell/node-pty"] }

        [vars]
        t3_version = "0.1.8-nightly.20261106.4262"
        """
      And between "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" these files change:
        | agents/registry.json |
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is made for the machines "worker-one"
      Then the plan lists no tool change
      And the plan restarts exactly:
        | service | ends running turns |
        | t3      | no                 |

    Scenario: The same revision again changes nothing, and reads nothing from Git
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is made for the machines "worker-one"
      Then the plan lists no tool change
      And the plan restarts nothing
      And no command was run

  Rule: A plan that cannot be read says so

    Scenario: Without the applied revision in a repository, the changes are unknown rather than absent
      Given no repository on the manager holds an older revision
      When the plan from "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" to "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" is made for the machines "worker-one"
      Then the plan says what it changes is not known
      And the plan lists no tool change

  Rule: A preview only reads

    Scenario: A preview of an enrolled worker runs only commands that read
      Given every command answers that it succeeded, printing nothing
      When the manager previews "fleet-sync --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dry-run --json" for the roster:
        | id         | ssh        | workspace |
        | worker-one | worker-one | /w        |
      Then every command the preview ran only reads, and each SSH session ran the read-only platform probe
      And the report has:
        | applied | false |
