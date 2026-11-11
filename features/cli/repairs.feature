Feature: fleet-repair previews repairs and applies only what was reviewed
  A repair is a fixed action its owner already provides: a setup script, a
  provider configuration. fleet-repair shows the plan, applies it only with
  --apply --yes, and then checks again. A login is never automated, and what
  a tool printed never reaches a report.

  Background:
    Given a workspace with its dependency files and no roster
    And every command on this manager succeeds
    And a command with the argument "rev-parse" prints "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Rule: The catalog of repairs is static

    Scenario: The catalog is listed without a roster and without running anything
      Given no command may run on this manager
      When the operator runs "devfleet fleet-repair --list"
      Then it exits with 0
      And it answers with at least:
        """
        { "command": "repairs", "ok": true }
        """
      And in the answer, "recipes" holds a list
      And in the answer, "credentials" holds a list
      And no command was run
      And no probe was bundled for workers

  Rule: A preview changes nothing

    Scenario: A preview with a script installs nothing, signs in nowhere and repeats nothing a tool printed
      Given every program other than "git" fails with "private-secret"
      When the operator runs "devfleet fleet-repair --local --script"
      Then it exits with 0
      And it answers with at least:
        """
        { "applied": false, "healthOk": false }
        """
      And in the answer, "planHash" holds a SHA-256 digest
      And no command that was run has the argument "personal:install"
      And no command that was run has the argument "bootstrap/setup.ts"
      And no command that was run starts with "gh auth login"
      And nothing it answers contains "private-secret"
      And the repair step "login:codex" is not automatic
      And the script contains "# cd --"
      But the script does not contain "auth.json"
      And the script is valid POSIX shell

    Scenario: A computer Tailscale shows but nobody registered stays in the plan as work for the operator
      Given Tailscale reports this inventory:
        """
        {
          "BackendState": "Running",
          "Health": null,
          "Self": {
            "ID": "self",
            "HostName": "self",
            "DNSName": "self.tailnet.ts.net.",
            "OS": "linux",
            "TailscaleIPs": ["100.64.0.1"],
            "Online": true
          },
          "Peer": {
            "offline": {
              "ID": "offline",
              "HostName": "offline",
              "DNSName": "offline.tailnet.ts.net.",
              "OS": "macOS",
              "TailscaleIPs": ["100.64.0.2"],
              "Online": false
            }
          }
        }
        """
      When the operator runs "devfleet fleet-repair"
      Then the program "ssh" was not run
      And it answers with at least:
        """
        {
          "applied": false,
          "healthOk": false,
          "coverage": { "scope": "tailscale-visible-computers" }
        }
        """
      And there are repair steps for "offline.tailnet.ts.net"
      And none of the repair steps for "offline.tailnet.ts.net" is eligible

  Rule: A change needs --apply and --yes, on a plan that is still the one reviewed

    Scenario Outline: "<command>" is refused before anything runs
      When the operator runs "<command>"
      Then it is refused
      And no command was run

      Examples:
        | command                                                          |
        | devfleet fleet-repair --local --apply                            |
        | devfleet fleet-repair --local --repair login:codex --apply --yes |
        | devfleet fleet-repair --local --repair arbitrary-secret-command  |
        | devfleet fleet-repair --local --require invalid-capability       |
        | devfleet fleet-repair --local --script --apply --yes             |

    Scenario: A plan that is not the one reviewed is refused and nothing is installed
      When the operator runs "devfleet fleet-repair --local --apply --yes --plan-hash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then it is refused with "plan changed"
      And no command that was run has the argument "personal:install"
      And no command that was run has the argument "bootstrap/setup.ts"

  Rule: After a repair the machine is checked again, and only that result counts

    Scenario: A repair that succeeds does not certify a machine that is still unhealthy
      Given a command with the argument "bootstrap/worker-auth.ts" prints:
        """
        {"ok":true,"private":"private-secret"}
        """
      When the operator runs "devfleet fleet-repair --local --require codex,workstation --repair providers --apply --yes"
      Then a command with the argument "bootstrap/worker-auth.ts" was run 1 time
      And the program "codex" was run 2 times
      And it exits with 1
      And it answers with at least:
        """
        {
          "applied": true,
          "executionOk": true,
          "healthOk": false,
          "ok": false,
          "completed": 1
        }
        """
      And nothing it answers contains "private-secret"

    Scenario: A setup that fails stops the repair, and what is still wrong is reported
      Given the program "mise" fails with "private-secret"
      When the operator runs "devfleet fleet-repair --local --apply --yes"
      Then it exits with 1
      And it answers with at least:
        """
        { "executionOk": false }
        """
      And in the answer, "remaining" holds a list
      And no command that was run has the argument "personal:install"
      And nothing it answers contains "private-secret"

  Rule: A worker is repaired over verified SSH, with a fixed action, and probed again

    Background:
      Given these workers are registered:
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      And the probe sent to workers is "fixture-probe"
      And every worker answers the probe as this workspace does at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And every worker answers a repair with:
        """
        {"version":1,"checks":[{"id":"repair:providers","status":"pass","summary":"owner completed"}]}
        """

    Scenario: The repair names the action and the state it was planned against, and the worker is probed again
      When the operator runs "devfleet fleet-repair --node dev-one --repair providers --apply --yes"
      Then only these programs were run:
        | ssh |
      And every command that was run has the argument "StrictHostKeyChecking=yes"
      And every command that was run has the argument "-a"
      And every command run over SSH was given the probe "fixture-probe"
      And workers were asked to repair 1 time
      And each repair a worker was asked for holds at least:
        """
        {
          "apply": true,
          "repairs": ["providers"],
          "node": { "workspace": "/home/dev/workspace" }
        }
        """
      And each repair a worker was asked for expects the fingerprint the worker reported
      And workers were probed 2 times
      And it answers with at least:
        """
        {
          "executionOk": true,
          "applied": true,
          "coverage": { "scope": "selected" }
        }
        """

    Scenario: A roster that breaks during the repair keeps what was done and reports no health as fresh
      Given the roster file is overwritten with "{changed-invalid-roster" while a worker is repaired
      When the operator runs "devfleet fleet-repair --node dev-one --repair providers --apply --yes"
      Then every request to a worker names the workspace "/home/dev/workspace"
      And it exits with 1
      And it answers with at least:
        """
        {
          "applied": true,
          "executionOk": true,
          "healthOk": false,
          "completed": 1,
          "nodes": [{ "checks": [{ "id": "repair:recheck", "status": "fail" }] }],
          "executions": [
            { "checks": [{ "id": "repair:providers", "status": "pass" }] }
          ]
        }
        """

  Rule: A generated script is safe to read and safe to run

    Scenario: A generated command passes a path and an argument on as they are
      The path of this workspace holds a space and an apostrophe.
      When a shell runs the command generated for the workspace from "printf %s" and this argument:
        """
        $(touch should-not-exist); ' private
        """
      Then it prints exactly that argument

    Scenario: A login the operator has to do stays a comment
      Given the machine "local", probed in this workspace at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", has these checks:
        | id         | status | summary |
        | auth:codex | fail   | Sign in |
      When the repair script is written
      Then every line of the script that contains "'codex'" is a comment
      And the script is valid POSIX shell
