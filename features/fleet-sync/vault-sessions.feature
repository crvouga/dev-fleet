Feature: Every machine keeps its own Vault session
  The proxy key, the GitHub token and the provider credentials all come from a
  machine's own Vault session. The manager reads each worker's issued token
  from Vault and delivers it once over SSH; an interactive run falls back to a
  password login on the worker's own terminal. A password never passes through
  fleet-sync.

  Background:
    Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet"

  Rule: A worker's issued token is delivered once, over standard input

    Scenario: The issued token of a worker is kept in a Vault field named after it
      The name matches the OpenTofu sink that writes it.
      Then the issued token of "worker-two" is kept in the Vault field "FLEET_WORKER_TOKEN_WORKER_TWO"

    Scenario: A worker that already has a session passes without a read or a prompt
      Given looking up the Vault session answers, in turn, "yes"
      And a prompt on the terminal would fail the scenario
      When the Vault session of that machine is authorized in an interactive sync
      Then the statuses of the checks are exactly:
        | pass |
      And 1 command was run

    Scenario: A worker without vault installed is left until after bootstrap
      Given looking up the Vault session answers, in turn, "vault-missing"
      And a prompt on the terminal would fail the scenario
      When the Vault session of that machine is authorized in an interactive sync
      Then there are no checks

    Scenario: The issued token is delivered over standard input, never as an argument
      Given looking up the Vault session answers, in turn, "no, yes"
      And Vault holds the issued token "hvs.issued-worker-token-0123456789" for that machine
      And that machine accepts a login with a token
      And a prompt on the terminal would fail the scenario
      When the Vault session of that machine is authorized in a noninteractive sync
      Then the statuses of the checks are exactly:
        | pass |
      And the token was read from Vault with "-field=FLEET_WORKER_TOKEN_WORKER_ONE"
      And the login on that machine was given "hvs.issued-worker-token-0123456789" and a new line on standard input
      And no command line contains "hvs.issued-worker-token-0123456789"

    Scenario: A noninteractive sync without an issued token reports the gap
      Given looking up the Vault session answers, in turn, "no"
      And a prompt on the terminal would fail the scenario
      When the Vault session of that machine is authorized in a noninteractive sync
      Then the first check's summary is "VAULT_LOGIN_REQUIRED"

    Scenario: An interactive sync falls back to a password login on the worker's terminal
      Given looking up the Vault session answers, in turn, "no, yes"
      And the operator completes every prompt on the terminal
      When the Vault session of that machine is authorized in an interactive sync
      Then the statuses of the checks are exactly:
        | pass |
      And the first prompt has the argument "-t"
      And the first prompt ends with a command that contains "'-method=userpass'"

    Scenario: A command that needs the terminal keeps verified host keys and only swaps the terminal flag
      When "vault status" is prepared for that machine with a terminal
      Then the SSH command has these arguments:
        | -t                        |
        | StrictHostKeyChecking=yes |
      But the SSH command does not have the argument "-T"

  Rule: The manager logs in first, and is prompted only when it has to be

    Scenario Outline: With the lookups "<lookups>", <mode> sync leaves the manager <result> after <prompts> prompts
      Given looking up the Vault session answers, in turn, "<lookups>"
      And the operator completes every prompt on the terminal
      When the Vault session of the manager is authorized in <mode> sync
      Then the manager is <result>
      And the operator was prompted <prompts> times

      Examples:
        | lookups | mode             | result        | prompts |
        | yes     | an interactive   | logged in     | 0       |
        | no      | a noninteractive | not logged in | 0       |
        | no, yes | an interactive   | logged in     | 1       |
