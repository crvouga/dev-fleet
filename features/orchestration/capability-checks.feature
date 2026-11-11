Feature: A capability is checked only when it is required, and a check keeps nothing it saw
  A registration says which capabilities a computer requires. A capability
  that is not required is skipped without asking anything; one that is
  required is asked through its own CLI, and what that CLI printed never
  reaches a report.

  Scenario: A checkout that requires no capability contacts no service
    Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    When the checkout is probed for no capability
    Then nothing but git was run
    And exactly these capabilities are skipped, and they are every capability there is:
      | github      |
      | vault       |
      | t3          |
      | vscode      |
      | toolchain   |
      | codex       |
      | claude      |
      | services    |
      | workstation |
      | worker      |

  Scenario Outline: A failed "<capability>" check exposes no credential, error or command output
    Given every command fails, printing "token=never-print-this" and the error output "password=never-print-this"
    When the capability "<capability>" is checked for the checkout "/repo"
    Then at least one check has failed
    And "never-print-this" appears nowhere in what is reported

    Examples:
      | capability |
      | github     |
      | vault      |
      | t3         |
      | vscode     |
      | toolchain  |

  Scenario Outline: VS Code is ready only when the Remote-SSH extension is among those installed: <case>
    A VS Code CLI that merely answers is not the extension.
    Given every command succeeds, printing "<extensions>"
    When the capability "vscode" is checked for the checkout "/repo"
    Then the first check has the status "<status>"

    Examples:
      | case                  | extensions                    | status |
      | the extension, listed | ms-vscode-remote.remote-ssh\n | pass   |
      | another extension     | unrelated.extension           | fail   |

  Scenario: T3 reports its settings, its local API and the untested end-to-end path separately
    Given a command with the argument "status" succeeds, printing:
      """
      { "connect": { "enabled": true, "revoked": false }, "token": "never-print-this" }
      """
    And every other command succeeds, printing "[]"
    When the capability "t3" is checked for the checkout "/repo"
    Then the statuses of the checks are, in order:
      | pass |
      | pass |
      | skip |
    And "never-print-this" appears nowhere in what is reported

  Scenario: A T3 connection that was revoked fails the settings check
    Given every command succeeds, printing '{"connect":{"enabled":true,"revoked":true}}'
    When the capability "t3" is checked for the checkout "/repo"
    Then the first check has the status "fail"

  Scenario: With no t3 launcher on PATH, the pinned native CLI is used
    Workers run only the T3 desktop app, so no `t3` launcher need be on PATH.
    Given the shell finds the t3 executable only at "/home/dev/.local/share/personal/tools/t3-0.1.8-linux-arm64/t3"
    And a command with the argument "status" succeeds, printing:
      """
      { "connect": { "enabled": true, "revoked": false } }
      """
    And every other command succeeds, printing "[]"
    When the capability "t3" is checked for the checkout "/repo"
    Then besides the shell, these executables were run, in order:
      | /home/dev/.local/share/personal/tools/t3-0.1.8-linux-arm64/t3 |
      | /home/dev/.local/share/personal/tools/t3-0.1.8-linux-arm64/t3 |
    And no check has failed
