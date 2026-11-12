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
      And every "curl" command was given "Authorization: Bearer PRIVATE_SENTINEL_TOKEN␊" on standard input
      And nothing reported contains "PRIVATE_SENTINEL_TOKEN"

  Rule: Unattended Vault access counts only when the worker's last renewal succeeded and its policy allows the read

    Background:
      Given these commands print:
        | command                                            | prints                                                 |
        | gh                                                 | example-user                                           |
        | vault token lookup                                 | {"data":{"renewable":true,"period":86400,"ttl":80000}} |
        | vault                                              | PRIVATE_SENTINEL_TOKEN                                 |
        | systemctl --user show personal-worker-auth.service | Result=success␊ExecMainStatus=0                        |
      And every other command prints '{"data":[{"id":"model"}]}'

    Scenario Outline: A renewal job whose last run <outcome> leaves "worker:vault-renewal" <verdict>
      An active timer says when renewal runs, not that it works.
      Given these commands print:
        | command                                            | prints    |
        | systemctl --user show personal-worker-auth.service | <renewal> |
      When the access of the worker is checked
      Then the check "worker:vault-renewal" <verdict>
      And the summary of the check "worker:vault-renewal" mentions "<summary>"
      And nothing reported contains "PRIVATE_SENTINEL"

      Examples:
        | outcome           | renewal                           | verdict | summary                 |
        | succeeded         | Result=success␊ExecMainStatus=0   | passes  | last renewal succeeded  |
        | failed            | Result=exit-code␊ExecMainStatus=1 | fails   | VAULT_RENEWAL_FAILING   |
        | has not run yet   | ExecMainStatus=0                  | passes  | last renewal succeeded  |

    Scenario: A Vault policy that refuses the proxy key is told apart from a missing login
      The token is valid, so the remedy is the policy, never a new secret.
      Given the command "vault kv get" fails with the error "Code: 403. Errors: * permission denied PRIVATE_SENTINEL"
      When the access of the worker is checked
      Then the check "worker:proxy-authentication" fails
      And the summary of the check "worker:proxy-authentication" mentions "VAULT_POLICY_PERMISSION_REQUIRED"
      And the remedy of the check "worker:proxy-authentication" mentions "seeds no secret"
      And the check "worker:vault-renewal" passes
      And nothing reported contains "PRIVATE_SENTINEL"

    Scenario Outline: A worker whose Vault token <situation> needs its own unattended identity
      Given the command "vault token lookup" <answer>
      When the access of the worker is checked
      Then the check "worker:vault-renewal" fails
      And the summary of the check "worker:vault-renewal" mentions "UNATTENDED_VAULT_IDENTITY_REQUIRED"

      Examples:
        | situation           | answer                                                          |
        | is missing          | fails                                                           |
        | cannot be renewed   | prints '{"data":{"renewable":false,"period":0,"ttl":3000}}'     |

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

  Rule: The recovery watchdog counts only when its script is there and its last run succeeded
    The unit runs a copy installed outside every revision, so pruning old
    revisions cannot leave it pointing at nothing. An active timer says when
    the watchdog runs, not that it works.

    Background:
      Given these commands print:
        | command                                                   | prints         |
        | systemctl --user is-active personal-worker-recovery.timer | active         |
        | test -r /usr/local/lib/personal-fleet/t3-health.sh        |                |
        | systemctl --user show personal-worker-recovery.service    | Result=success |

    Scenario: A watchdog whose last run succeeded passes
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" passes

    Scenario: A watchdog whose last run failed fails
      Given the command "systemctl --user show personal-worker-recovery.service" prints "Result=exit-code"
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_LAST_RUN_FAILED (exit-code)"

    Scenario: A watchdog whose script is missing fails
      Given the command "test -r /usr/local/lib/personal-fleet/t3-health.sh" fails
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_SCRIPT_MISSING"

    Scenario: A watchdog whose timer is not active fails
      Given the command "systemctl --user is-active personal-worker-recovery.timer" fails
      When the worker's service recovery is checked
      Then the check "worker:service-recovery" fails
      And the summary of the check "worker:service-recovery" mentions "WORKER_RECOVERY_TIMER_INACTIVE"

  Rule: The running T3 is the release that is installed
    The running server is asked for its version, so no "t3" on the search
    path is needed. A release installed beside a running app is pending until
    the app restarts into it, which waits for its agent turns to end, and
    fails once it has waited longer than the policy allows (24 hours).

    Background:
      Given these commands print:
        | command | prints                                          |
        | curl    | {"serverVersion":"0.1.9-nightly.20261111.4501"} |
        | cat     | T3-Code-0.1.9-nightly.20261111.4501-amd64.deb   |

    Scenario: A T3 that runs the installed release passes
      When the release of the running T3 is checked
      Then the check "t3:running-version" passes
      And no "t3" command was run

    Scenario: A release installed without a restart is pending
      Given the command "cat" prints "T3-Code-0.1.10-nightly.20261112.4600-amd64.deb"
      And a restart of T3 has been deferred for 2 hours
      When the release of the running T3 is checked
      Then the check "t3:running-version" warns
      And the summary of the check "t3:running-version" mentions "T3_RESTART_PENDING"

    Scenario: A restart deferred longer than the policy allows fails
      Given the command "cat" prints "T3-Code-0.1.10-nightly.20261112.4600-amd64.deb"
      And a restart of T3 has been deferred for 25 hours
      When the release of the running T3 is checked
      Then the check "t3:running-version" fails
      And the summary of the check "t3:running-version" mentions "T3_RESTART_PENDING"

    Scenario: A server that does not say its version is not taken to run the installed one
      Given the command "curl" fails
      When the release of the running T3 is checked
      Then the check "t3:running-version" fails
      And the summary of the check "t3:running-version" mentions "T3_RUNNING_VERSION_UNKNOWN"

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
