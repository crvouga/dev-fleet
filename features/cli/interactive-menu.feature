Feature: The interactive menu
  devfleet --interactive is a command palette over the same commands an agent
  runs. It opens only for a person who asks for it, runs nothing that changes
  a machine without an explicit yes, and shows the exact command it runs.

  Rule: The menu opens only for a person at a terminal who asks for it
    Agents, redirected terminals and CI are never prompted.

    Scenario Outline: "<command>", started <where>: the menu <opens>
      When "<command>" is started <where>
      Then the interactive menu <opens>

      Examples:
        | command                           | where               | opens         |
        | devfleet                          | at a terminal       | does not open |
        | devfleet --config /tmp/fleet.json | at a terminal       | does not open |
        | devfleet --interactive            | at a terminal       | opens         |
        | devfleet --interactive            | at a terminal in CI | does not open |
        | devfleet --interactive t3-cleanup | at a terminal       | does not open |
        | devfleet fleet-nodes              | at a terminal       | does not open |
        | devfleet --json --interactive     | at a terminal       | does not open |
        | devfleet --non-interactive        | at a terminal       | does not open |
        | devfleet                          | without a terminal  | does not open |
        | devfleet                          | at a terminal in CI | does not open |

  Rule: The palette is one flat list of every command

    Background:
      Given the interactive menu of devfleet "1.2.3", released at "2026-01-02T03:04:05.000Z", for the workspace "/workspace" and the roster "/fleet.json"

    Scenario: With nothing typed, every command is listed once, A to Z
      When the palette is searched for ""
      Then its entries are sorted by name, A to Z
      And none of its entries is a group
      And it has one entry for each command in the catalog

    Scenario: Typing narrows the palette to what matches
      When the palette is searched for "nodes"
      Then it offers the command "fleet-nodes"

  Rule: The menu runs the same commands an agent would, and changes nothing without a yes

    Background:
      Given the interactive menu of devfleet "1.2.3", released at "2026-01-02T03:04:05.000Z", for the workspace "/workspace" and the roster "/fleet.json"
      And the operator ticks "github, t3" whenever a list of boxes is offered
      And every command the menu runs answers:
        """
        { "version": 1, "ok": true, "nodes": [] }
        """

    Scenario: A command for this manager only does not ask which workers
      Given the operator opens "fleet-status --local" from the palette, then exits
      When the menu runs
      Then the menu runs exactly these commands:
        | fleet-status --local |
      And the operator is never asked "Choose target scope"
      And the screen shows "--json"

    Scenario: Registering a worker writes nothing when the operator declines
      Given the operator opens "fleet-node-add" from the palette, then exits
      And the operator types, in turn:
        | dev-one             |
        | dev-one             |
        | /home/dev/workspace |
        |                     |
      And the operator declines when asked
      When the menu runs
      Then the menu runs no command
      And the screen shows "no roster was written"

    Scenario: Registering a worker, once confirmed, runs the command an agent would
      Given the operator opens "fleet-node-add" from the palette, then exits
      And the operator types, in turn:
        | dev-one             |
        | dev-one             |
        | /home/dev/workspace |
        | /usr/bin/node       |
      And the operator confirms when asked
      When the menu runs
      Then the menu runs exactly these commands:
        | fleet-node-add --id dev-one --ssh dev-one --path /home/dev/workspace --runtime /usr/bin/node --require github,t3 --apply --yes |

    Scenario: Approving a repair applies the plan that was reviewed
      Given every command the menu runs answers this, as applied only when run with "--apply":
        """
        {
          "version": 1,
          "command": "repair",
          "ok": true,
          "planHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "nodes": [],
          "steps": []
        }
        """
      And the operator opens "fleet-repair" from the palette, then exits
      And the operator picks from each list, in turn:
        | local |
        | apply |
        | back  |
      And the operator confirms when asked
      When the menu runs
      Then the menu runs exactly these commands:
        | fleet-repair --local                                                                                            |
        | fleet-repair --local --plan-hash bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --apply --yes |
      And the screen shows "Vault"

    Scenario: Cancelling leaves the menu without showing what was thrown
      Given the operator cancels at the palette, which raises an "ExitPromptError" that says "private-stack-token"
      When the menu runs
      Then the menu ends with an error
      And the screen does not show "private-stack-token"
      And the menu runs no command

  Rule: A result is shown as it is, and a suggestion is never run

    Background:
      Given the interactive menu of devfleet "1.2.3", released at "2026-01-02T03:04:05.000Z", for the workspace "/workspace" and the roster "/fleet.json"
      And every command the menu runs answers:
        """
        { "version": 1, "ok": true, "nodes": [] }
        """

    Scenario: A report filtered by status keeps the remedy and runs nothing it suggests
      Given a report with these checks:
        | machine | id       | status | summary          | remedy               | command    |
        | dev     | ok       | pass   | fine             |                      |            |
        | dev     | ssh:auth | fail   | SSH key rejected | Inspect keys locally | ssh-add -l |
      And the operator picks from each search, in turn:
        | status |
        | 0      |
        | back   |
      And the operator picks from each list, in turn:
        | fail |
      When the operator explores the checks of the report
      Then the operator is asked a question containing "1/2 checks"
      And the screen shows "Suggested operator command (not executed)"
      And the menu runs no command

    Scenario: A repair that was applied and failed says actions were attempted
      When the menu shows a command that exited with 1 and answered:
        """
        {
          "command": "repair",
          "applied": true,
          "ok": false,
          "executionOk": true,
          "healthOk": false,
          "completed": 1,
          "nodes": [],
          "steps": []
        }
        """
      Then the screen shows "Actions were attempted"
      But the screen does not show "No automatic repair was attempted"

    Scenario: Text from a machine is shown without escape sequences or control characters
      When this text, written with its escapes, is prepared for the terminal:
        """
        \x1b[31mred\x1b[0m\x1b]0;title\x07\nvalue
        """
      Then it reads "red value"
