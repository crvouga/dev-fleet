# ␊ stands for a line break.
Feature: What is measured on a worker
  A worker is measured where it runs, by commands that only read. A check
  passes on what was observed, never on what an installer once recorded, and
  it reports what it concluded, not what a command printed.

  Rule: A worker proves its access to the proxy without spending a request on a model

    Scenario: The proxy key reaches the proxy on standard input and nowhere else
      The worker reads its own key, lists the models of the proxy with it and
      looks up its own Vault token. The key is in no command line and in no
      check.
      Given these commands print:
        | command            | prints                                                 |
        | gh                 | example-user                                           |
        | vault token lookup | {"data":{"renewable":true,"period":86400,"ttl":80000}} |
        | vault              | PRIVATE_SENTINEL_TOKEN                                 |
      And every other command prints '{"data":[{"id":"model"}]}'
      When the access of the worker is checked
      Then every check passes
      And no command line contains "PRIVATE_SENTINEL_TOKEN"
      And every command other than "gh" and "vault" was given "Authorization: Bearer PRIVATE_SENTINEL_TOKEN␊" on standard input
      And nothing reported contains "PRIVATE_SENTINEL_TOKEN"

  Rule: Recovery after a power loss never passes without a firmware setting that was read

    Scenario: A worker whose firmware cannot be read is skipped
      Given every command fails
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" is skipped

    Scenario: A worker whose firmware powers on after a power loss passes
      Given every command prints:
        """
        {"BiosSettings":[{"Name":"AfterPowerLoss","CurrentValue":"Power On"}]}
        """
      When the recovery of the worker after a power loss is checked
      Then the check "worker:power-loss-recovery" passes

  Rule: The devfleet launcher is looked for, and nothing a command printed is reported

    Scenario: A launcher that is there passes, after one command that only reads
      Given every command prints "PRIVATE_SENTINEL"
      When the devfleet launcher of the checkout at "/checkout" is checked
      Then the check "workstation:configuration" passes
      And exactly 1 command was run
      And only "test" commands were run
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario: A launcher that is missing fails
      Given every command fails, printing "PRIVATE_SENTINEL"
      When the devfleet launcher of the checkout at "/checkout" is checked
      Then the check "workstation:configuration" fails
      And nothing reported contains "PRIVATE_SENTINEL"

  Rule: A failed service check names what was observed

    Scenario: A service with no unit file is reported as not installed
      When systemd shows the service "beszel-agent" as:
        """
        ActiveState=inactive
        UnitFileState=
        Restart=no
        """
      Then the service is reported as "SERVICE_NOT_INSTALLED beszel-agent.service (inactive, unit file missing, restart no)"

    Scenario: A service that failed is reported as not running
      When systemd shows the service "beszel-agent" as:
        """
        ActiveState=failed
        UnitFileState=enabled
        Restart=always
        """
      Then the report of the service starts with "SERVICE_NOT_RUNNING"
