Feature: Every check that did not pass has a repair or an operator step
  A repair plan accounts for every check that did not pass. dev-fleet runs
  only the repairs it owns, with commands fixed in its catalog: never a login,
  never Docker, never a decision about trust, and never a command a check or
  a registration suggested.

  Rule: The plan covers every check and automates only what dev-fleet owns

    Background:
      Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And the computer under repair reported these checks:
        | id                 | status | summary             | remedy               | remedy command |
        | tool:node          | fail   | wrong version       |                      |                |
        | dependencies       | warn   | stale               |                      |                |
        | auth:codex         | fail   | missing             |                      |                |
        | auth:github        | fail   | missing             |                      |                |
        | tool:github-auth   | warn   | missing             |                      |                |
        | tool:docker-engine | fail   | not running         |                      |                |
        | workstation:path   | fail   | not linked          |                      |                |
        | t3:end-to-end      | skip   | unverified          |                      |                |
        | ssh:host-key       | fail   | unknown             | Verify independently | DO-NOT-EXECUTE |
        | future:unknown     | warn   | needs investigation |                      |                |
        | auth:aws           | pass   | signed in           |                      |                |

    Scenario: Logins, Docker, host trust and unknown checks are never repaired automatically
      Given the computer is "local", whose checkout was probed and can be repaired
      When the repair plan is drawn up
      Then every check that did not pass belongs to exactly one step
      And the step "workspace" covers 2 checks
      And the step "login:github" covers 2 checks
      And only these steps are automatic, in order:
        | workspace   |
        | workstation |
      And "DO-NOT-EXECUTE" is in no command of any step

    Scenario: No step is eligible on a computer that could not be probed
      Given the computer is "unreachable", which could not be probed
      When the repair plan is drawn up
      Then no step is eligible

  Rule: Automatic repairs run their prerequisites first

    Scenario: The launcher is repaired after the tools it needs, whatever order the checks came in
      Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And the computer under repair reported these checks:
        | id               | status | summary |
        | workstation:path | fail   | missing |
        | tool:node        | fail   | missing |
      And the computer is "local", whose checkout was probed and can be repaired
      When the repair plan is drawn up
      Then the automatic repairs of "local" are, in order:
        | workspace   |
        | workstation |

    Scenario: A failed repair stops the repairs after it, and its output is not reported
      Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And any "mise" command fails with the error output "private-secret"
      When the repairs "providers, workstation, workspace" are applied to the checkout
      Then the first check has the status "fail"
      And besides git, only the "workspace" command of the repair catalog was run:
        """
        mise exec --locked bun -- bun bootstrap/setup.ts --non-interactive
        """
      And "private-secret" appears nowhere in what is reported

  Rule: A repair runs the command of its owner and nothing else

    Background:
      Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: Refreshing provider credentials never logs in, escalates or copies a key
      When the repairs "providers" are applied to the checkout
      Then the checks are:
        | id               | status |
        | repair:providers | pass   |
      And besides git, only the "providers" command of the repair catalog was run:
        """
        bun bootstrap/worker-auth.ts
        """
      And no command with the argument "login" was run
      And no command with the argument "sudo" was run
      And no command with the argument "scp" was run
      And no command with the argument "rsync" was run

    Scenario: A checkout whose inputs changed since it was diagnosed is not repaired
      Given the fingerprint of the checkout was taken as the reference
      And "mise.lock" then changes to "changed"
      When the repairs "workstation" are applied to the checkout against the reference fingerprint
      Then the first check is "repair:inputs"
      And the first check has the status "fail"
      And nothing but git was run

    Scenario Outline: A request for <request> is not a list of distinct automated repairs
      When a worker is asked for the repairs <request>
      Then the repair request is refused

      Examples:
        | request                    |
        | []                         |
        | ["login:codex"]            |
        | ["workspace", "workspace"] |
        | ["rm -rf"]                 |
        | "workspace"                |

  Rule: A worker repairs only on an explicit and complete request

    Background:
      Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And the worker "dev-one" at the SSH alias "dev-one" works in that checkout

    Scenario Outline: The probe on a worker refuses a repair request that <fault>
      This runs the probe the manager would send, bundled from the current
      source, in a real process: the refusal comes before anything is changed.
      When the bundled probe is asked to repair with "apply" <apply>, the repairs <repairs> and <fingerprint>
      Then the process fails
      And it prints a version 1 document that carries an error

      Examples:
        | fault                             | apply | repairs         | fingerprint                     |
        | was not approved to apply         | false | ["workspace"]   | the fingerprint of the checkout |
        | names a repair that is not listed | true  | ["login:codex"] | the fingerprint of the checkout |
        | carries no fingerprint            | true  | ["workspace"]   | no fingerprint                  |

    Scenario: A repair that comes back without a single check is a protocol failure, not a success
      Given the probe source is "fixture"
      And the fingerprint of the checkout was taken as the reference
      And every SSH session succeeds, printing:
        """
        {"version":1,"checks":[]}
        """
      When the manager asks the worker to apply the repairs "providers" against the reference fingerprint
      Then the checks are:
        | id           | status |
        | ssh:protocol | fail   |
