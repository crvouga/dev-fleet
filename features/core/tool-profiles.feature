Feature: Workers add locked tool profiles to their base tools
  Every worker installs the base tools (`worker_tools` in mise.toml). The
  fleet configuration adds named profiles, fleet-wide under `worker` or for
  one worker, and single tools dev-fleet already pins. Each profile is a tool
  set dev-fleet ships in mise.toml, so every version still comes from
  mise.lock, and the doctor checks each added tool as `tool:<name>`.

  Background:
    Given the example fleet configuration

  Scenario: tmux is a base tool, pinned and locked like the others
    Then the base tools include "tmux"
    And every base tool is pinned in mise.toml and locked in mise.lock

  Scenario Outline: The profile "<profile>" names only tools mise.toml pins and mise.lock locks
    Then the tool profile "<profile>" adds "<tools>"
    And every tool of the profile "<profile>" is pinned in mise.toml and locked in mise.lock

    Examples:
      | profile | tools                            |
      | web     | pnpm,deno,npm:@yarnpkg/cli-dist  |
      | go      | go                               |
      | rust    | rust,cmake,ninja                 |
      | jvm     | java                             |

  Scenario: A fleet-wide profile adds its tools to every worker, after the base tools
    Given the fleet configuration sets "worker.toolProfiles" to ["go"]
    When the fleet configuration is read
    Then the worker "worker-one" installs the base tools, then these:
      | go |
    And the worker "worker-two" installs the base tools, then these:
      | go |

  Scenario: A worker's own profile is added to the fleet-wide ones for that worker only
    Given the fleet configuration sets "worker.toolProfiles" to ["go"]
    And the fleet configuration sets the "toolProfiles" of the worker "worker-two" to ["rust"]
    When the fleet configuration is read
    Then the worker "worker-one" installs the base tools, then these:
      | go |
    And the worker "worker-two" installs the base tools, then these:
      | go    |
      | rust  |
      | cmake |
      | ninja |

  Scenario: A single tool dev-fleet pins is added once, after the profiles
    Given the fleet configuration sets "worker.toolProfiles" to ["web"]
    And the fleet configuration sets "worker.tools" to ["fd", "pnpm"]
    When the fleet configuration is read
    Then the worker "worker-one" installs the base tools, then these:
      | pnpm                  |
      | deno                  |
      | npm:@yarnpkg/cli-dist |
      | fd                    |

  Scenario: Without a profile a worker installs only the base tools
    Given the fleet configuration leaves out "worker.toolProfiles"
    When the fleet configuration is read
    Then the worker "worker-one" installs the base tools, then these:
      | (none) |

  Scenario Outline: <case> is refused
    Given the fleet configuration sets <path> to <value>
    When the fleet configuration is read
    Then it is refused

    Examples:
      | case                              | path                                         | value            |
      | A profile dev-fleet does not ship | "worker.toolProfiles"                        | ["mobile"]       |
      | A profile named twice             | "worker.toolProfiles"                        | ["go", "go"]     |
      | A worker's unknown profile        | the "toolProfiles" of the worker "worker-one" | ["cobol"]       |

  Scenario: A tool dev-fleet does not pin is refused when the worker's tools are chosen
    Given the fleet configuration sets "worker.tools" to ["unpinned-tool"]
    When the fleet configuration is read
    Then choosing the tools of the worker "worker-one" is refused with "Ask for it in an issue"

  Scenario: The worker's toolchain check asks the doctor for the worker's own profiles
    Given the fleet configuration sets "worker.toolProfiles" to ["go"]
    And the fleet configuration sets the "toolProfiles" of the worker "worker-two" to ["rust"]
    And the doctor of the checkout reports ok, with these checks:
      | id   | status | detail |
      | go   | pass   | 1.27.3 |
      | rust | pass   | 1.99.1 |
    When the toolchain of the worker "worker-two" in the checkout at "/repo" is checked
    Then the doctor was run with "--worker --profiles go,rust"
    And the check "tool:go" passes
    And the check "tool:rust" passes

  Scenario: The doctor checks every tool a profile adds, lazy ones included
    Given every tool prints the version mise.toml pins for it
    When the doctor checks a worker with the profiles "jvm,rust"
    Then the doctor's checks include, each passing:
      | java  |
      | rust  |
      | cmake |
      | ninja |

  Scenario: Temurin is checked against the version java prints
    Given the tool command "java" prints "openjdk 25.0.5 2026-10-21 LTS"
    When the doctor checks the tool "java" pinned at "temurin-25.0.5+8.0.LTS"
    Then the doctor's check "java" passes
