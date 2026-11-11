Feature: The doctor checks a machine's toolchain
  The doctor only reads: it signs in to nothing, installs nothing and
  changes nothing in Docker.

  Rule: A tool must report exactly the version it is pinned to

    Scenario: A shadowed or wrong tool version fails, and a lazy tool is not checked
      Given the toolchain pins:
        | tool  | version | lazy |
        | node  | 22.22.3 |      |
        | bun   | 1.4.4   |      |
        | atlas | 1.3.0   | yes  |
      And the command "node" prints "v20.0.0"
      And every other command prints "1.4.4"
      When the doctor checks the tools
      Then the check "node" fails
      And the check "bun" passes
      And there is no check "atlas"

    Scenario Outline: A version check accepts sentence punctuation but rejects a longer version
      Given the toolchain pins:
        | tool    | version |
        | copilot | 1.0.105 |
      And the command "copilot" prints "<output>"
      When the doctor checks the tools
      Then the check "copilot" <verdict>

      Examples:
        | output                       | verdict |
        | GitHub Copilot CLI 1.0.105.  | passes  |
        | GitHub Copilot CLI 1.0.1050  | fails   |
        | GitHub Copilot CLI 1.0.105.1 | fails   |

  Rule: A tool with no artifact for this platform is skipped, but not native Windows AWS
    On Windows aws is installed by its own installer, not by mise.

    Scenario Outline: On <platform> the doctor checks <checked>
      Given the toolchain pins:
        | tool      | version | os           |
        | http:grok | 1.0.77  | linux, macos |
        | aws       | 2.39.2  | linux, macos |
      And no command can be run
      When the doctor checks the tools on "<platform>"
      Then of the pinned tools it checks <checked>

      Examples:
        | platform | checked            |
        | win32    | "aws"              |
        | linux    | "http:grok", "aws" |
        | darwin   | "http:grok", "aws" |

  Rule: Docker is optional unless the machine requires it

    Scenario Outline: Without Docker, a machine that <requirement> it <verdict>
      Given no command can be run
      When the doctor checks Docker on a machine that <requirement> it
      Then every Docker check <verdict>

      Examples:
        | requirement      | verdict |
        | does not require | warns   |
        | requires         | fails   |

  Rule: The doctor fails when an agent worktree root is not trusted
    Every mise shim fails in a new worktree under a root mise does not trust.

    Scenario Outline: mise trusting <paths> <verdict>
      Given mise says it trusts the configuration paths <paths>
      When the doctor checks that agent worktrees are trusted, for the home "/home/dev"
      Then the check "agent-worktree-trust" <verdict>

      Examples:
        | paths                       | verdict |
        | ["/home/dev/.t3/worktrees"] | passes  |
        | ["~/.t3/worktrees"]         | passes  |
        | []                          | fails   |

    Scenario: A mise that cannot say what it trusts fails the check
      Given mise cannot say which configuration paths it trusts
      When the doctor checks that agent worktrees are trusted, for the home "/home/dev"
      Then the check "agent-worktree-trust" fails
