# ␊ stands for a line break.
Feature: A computer's sign-ins are proved by the tools themselves
  Whether a computer is signed in to a coding agent or a service is what that
  tool's own status command says, in so many words. A saved file, an installed
  binary or a command that merely succeeds proves nothing. Whatever the tool
  printed, an account name or a token, is never kept.

  Rule: A coding agent is signed in when its status command says so

    Scenario: Codex says it is logged in, and what it printed is not kept
      Given the command "codex login status" succeeds and says "Logged in using an API key - private-secret" on standard error
      When the "codex" sign-in is checked
      Then the check "auth:codex" passes
      And the only command run was:
        | codex | login | status |
      And nothing reported contains "private-secret"

    Scenario Outline: Codex is not signed in when <situation>
      Given <answer>
      When the "codex" sign-in is checked
      Then the check "auth:codex" fails

      Examples:
        | situation                | answer                                              |
        | it only prints its usage | every command prints "Usage: codex"                 |
        | its status command fails | every command fails with the error "private-secret" |

    Scenario Outline: Claude is not signed in when its status prints <status>
      A saved file or a zero exit alone is not a sign-in: the status must be
      valid JSON that says loggedIn is true.
      Given every command prints '<status>'
      When the "claude" sign-in is checked
      Then the check "auth:claude" fails

      Examples:
        | status             |
        | {}                 |
        | {"loggedIn":false} |
        | not-json           |

    Scenario: Claude says it is logged in, and its token is not kept
      Given the command "claude auth status --json" prints '{"loggedIn":true,"token":"private-secret"}'
      When the "claude" sign-in is checked
      Then the check "auth:claude" passes
      And the only command run was:
        | claude | auth | status | --json |
      And nothing reported contains "private-secret"

  Rule: A service is signed in when its own command names an identity

    Scenario: Every service names an identity, and none of them is kept
      Given these commands print:
        | command  | prints                                               |
        | railway  | {"id":"private-account"}                             |
        | vercel   | private-account␊                                     |
        | wrangler | {"loggedIn":true,"token":"private-secret"}           |
        | aws      | {"Account":"private-account","Arn":"private-secret"} |
        | npm      | private-account␊                                     |
      When the sign-ins to the services are checked
      Then 5 checks pass
      And every command was given 15 seconds to answer
      And nothing reported contains "private-account"
      And nothing reported contains "private-secret"

    Scenario: A command that succeeds without naming an identity proves nothing
      Given every command prints "{}"
      When the sign-ins to the services are checked
      Then 0 checks pass

    Scenario: A missing command is no sign-in, and a CLI that signs in through the proxy is not applicable
      Nothing is signed in on the computer's behalf, and no provider is
      certified by a check that does not exist. Copilot CLI uses the node's
      GitHub sign-in, so it is checked when it is installed (features/github).
      An agent CLI that signs in only through the CLI proxy has no sign-in
      of its own: its check says so, and where its access is proven instead.
      Given every command fails with the error "private-secret"
      When the sign-ins to the services are checked
      Then 5 checks fail
      And these checks are skipped, in this order:
        | auth:copilot |
      And the summary of the check "auth:copilot" mentions "not installed"
      And these checks are not applicable, saying "AUTH_NOT_SUPPORTED_ON_ROUTE" and where their access is proven:
        | auth:gemini      |
        | auth:opencode    |
        | auth:grok        |
        | auth:antigravity |
      And no command was run with the argument "login"
      And nothing reported contains "private-secret"

    Scenario: Every agent CLI the registry names has a sign-in check, and none is skipped without a reason
      Given every command fails with the error "private-secret"
      When the sign-ins of every agent CLI the registry names are checked
      Then there is an "auth:" check for each of them
      And every "auth:" check that is skipped or not applicable states its reason
