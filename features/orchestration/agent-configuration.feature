Feature: An agent profile is configured from one reviewed commit
  A worker configures a coding agent only for an exact commit, and from a
  checkout that is that commit and nothing else. The receipt of a rollout
  advances only when the owner of the profile proves it applied that commit;
  nothing a subprocess printed is reported.

  Rule: A request names an exact commit and plain names

    Scenario Outline: A request for <what> is <verdict>
      When a request arrives to configure the revision "<revision>" on the worker "<worker>" for the tool "<tool>" with the profile "<profile>"
      Then the configuration request is <verdict>

      Examples:
        | what                                    | revision                                 | worker    | tool  | profile | verdict  |
        | a full commit and plain names           | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | canary    | codex | proxy   | accepted |
        | a branch instead of a commit            | main                                     | canary    | codex | proxy   | refused  |
        | a worker name that leaves its directory | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | ../escape | codex | proxy   | refused  |

    Scenario Outline: A receipt counts only when it is for the reviewed commit: <case>
      When the owner of the agent profile prints <output> for the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then the receipt is <verdict>

      Examples:
        | case                | output                                                                                                                                             | verdict                                                                                          |
        | the reviewed commit | {"ok":true,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"} | accepted with the fingerprint "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" |
        | another commit      | {"ok":true,"revision":"cccccccccccccccccccccccccccccccccccccccc","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"} | not accepted                                                                                     |
        | no receipt at all   | secret response                                                                                                                                    | not accepted                                                                                     |

  Rule: A checkout is configured only when it is the reviewed commit, unchanged

    Background:
      Given this request to configure an agent profile:
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
        | worker   | canary                                   |
        | tool     | codex                                    |
        | profile  | proxy                                    |

    Scenario: A commit the checkout does not hold fails before anything is changed
      Given every command fails, printing "PRIVATE_SENTINEL" and the error output "PRIVATE_SENTINEL"
      When the checkout "/unused" is configured
      Then the first check has the status "fail"
      And 1 command was run
      And "PRIVATE_SENTINEL" appears nowhere in what is reported

    Scenario: A setup that fails leaves the receipt of the last successful rollout as it was
      Given an empty directory
      And the file "node_modules/.fleet-configuration/canary-codex-proxy.json" was written with "previous-success"
      And git reports every directory it is asked about as a clean worktree at the requested revision
      And every command writes "PRIVATE_SENTINEL" to its error output
      And any "mise" command fails with the error output "PRIVATE_SENTINEL"
      When the checkout is configured
      Then the first check has the status "fail"
      And the file "node_modules/.fleet-configuration/canary-codex-proxy.json" still holds "previous-success"
      And "PRIVATE_SENTINEL" appears nowhere in what is reported

    Scenario: A revision that bootstrap already prepared is verified and configured without a second setup or worktree
      Given an empty directory
      And git reports every directory it is asked about as a clean worktree at the requested revision
      And a command with the argument "agents" succeeds, printing:
        """
        {"ok":true,"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        """
      When the bootstrapped checkout is configured, with "opencode" as an additional tool
      Then every check has passed
      And no command with the argument "bootstrap/setup.ts" was run
      And no command with the argument "worktree" was run
      And 2 commands with the argument "agents" were run

    Scenario: A checkout marked as prepared is still inspected for drift
      Given git reports every directory it is asked about as a clean worktree at the requested revision
      But git reports the uncommitted change " M tracked-file"
      When the bootstrapped checkout "/managed" is configured
      Then the first check has the status "fail"
      And no command with the argument "agents" was run
