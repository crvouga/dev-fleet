Feature: Every node signs in to GitHub from the stored credential
  The fleet's GitHub token is a declared secret, "github-token", read through
  whichever secrets provider the fleet uses. A node is signed in as the fleet
  login with it, and the token reaches gh on standard input only. GitHub
  sign-in is a job of its own: a failure of the Vault renewal never stops or
  hides it, and each of its failures names the system to fix.

  Background:
    Given the fleet login is "example-user"
    And GitHub knows the token "TOKEN_A_PRIVATE_0001" as "example-user"

  Rule: One sync signs a fresh worker in, whatever the secrets provider

    Scenario Outline: A fresh worker is signed in after one sync with the "<provider>" secrets provider
      Given the fleet keeps its secrets with the "<provider>" provider
      And the store holds "TOKEN_A_PRIVATE_0001" as "github-token"
      And "worker-one" is not signed in to GitHub
      When the GitHub sign-in job runs on "worker-one"
      Then the result on "worker-one" is "GITHUB_OK"
      And "worker-one" holds the token "TOKEN_A_PRIVATE_0001"
      And no command line contains "TOKEN_A_PRIVATE_0001"

      Examples:
        | provider |
        | env      |
        | file     |
        | sops     |
        | vault    |

  Rule: A sign-in that cannot be made says why

    Scenario Outline: <case> is reported as "<code>"
      Given GitHub knows the token "TOKEN_B_PRIVATE_0002" as "someone-else"
      And GitHub knows the token "TOKEN_R_PRIVATE_0003" as "example-user"
      And GitHub has revoked the token "TOKEN_R_PRIVATE_0003"
      And the store holds "<stored>" as "github-token"
      And <network>
      And "worker-one" is not signed in to GitHub
      When the GitHub sign-in job runs on "worker-one"
      Then the result on "worker-one" is "<code>"
      And "worker-one" is not signed in

      Examples:
        | case                                | stored               | network                   | code                  |
        | A store without a token             | nothing              | GitHub can be reached     | GITHUB_TOKEN_MISSING  |
        | A token GitHub has revoked          | TOKEN_R_PRIVATE_0003 | GitHub can be reached     | GITHUB_TOKEN_REJECTED |
        | A token of another login            | TOKEN_B_PRIVATE_0002 | GitHub can be reached     | GITHUB_LOGIN_MISMATCH |
        | A node that cannot reach GitHub     | TOKEN_A_PRIVATE_0001 | GitHub cannot be reached  | GITHUB_UNREACHABLE    |

  Rule: GitHub sign-in is measured apart from the Vault renewal

    Background:
      Given the fleet keeps its secrets with the "vault" provider
      And these commands answer:
        | command                                                       | answer                                                        |
        | vault token lookup -address=https://vault.example.com -format=json | prints {"data":{"renewable":true,"period":86400,"ttl":80000}} |
        | vault kv get … -field=CLIPROXY_FLEET_CLIENT_API_KEY fleet/prd | prints PRIVATE_PROXY_KEY_000                                  |
        | curl …                                                        | prints {"data":[{"id":"model"}]}                              |

    Scenario: A stored token of another login is a GitHub fault, and the renewal check still passes
      Given GitHub knows the token "TOKEN_B_PRIVATE_0002" as "someone-else"
      And the store holds "TOKEN_B_PRIVATE_0002" as "github-token"
      And "worker-one" is not signed in to GitHub
      And the command "systemctl --user show personal-worker-auth.service --property=Result,ExecMainStatus" prints Result=success\nExecMainStatus=0
      When the access of "worker-one" is checked
      Then the check "worker:github-sync" fails
      And the check "worker:github-sync" says "GITHUB_LOGIN_MISMATCH"
      And the remedy of the check "worker:github-sync" mentions "worker.githubLogin"
      And the check "worker:vault-renewal" passes
      And nothing reported contains "TOKEN_B_PRIVATE_0002"

    Scenario: A failing Vault renewal leaves the GitHub result as it is
      Given the store holds "TOKEN_A_PRIVATE_0001" as "github-token"
      And "worker-one" is signed in with "TOKEN_A_PRIVATE_0001"
      And the command "systemctl --user show personal-worker-auth.service --property=Result,ExecMainStatus" prints Result=exit-code\nExecMainStatus=1
      When the access of "worker-one" is checked
      Then the check "worker:vault-renewal" fails
      And the check "worker:github-sync" passes

  Rule: A sync fails when the node cannot be signed in

    Scenario Outline: A sign-in job that reports "<code>" leaves "github:sync" <verdict>
      Given the command "bun bootstrap/worker-github.ts --node worker-one" prints {"name":"dev-fleet-github","event":"job_finished","code":"<code>","adopted":false}
      When the GitHub sign-in of "worker-one" is converged
      Then the check "github:sync" <verdict>
      And the check "github:sync" says "<summary>"

      Examples:
        | code                  | verdict | summary               |
        | GITHUB_OK             | passes  | declared login        |
        | GITHUB_TOKEN_MISSING  | fails   | GITHUB_TOKEN_MISSING  |
        | GITHUB_LOGIN_MISMATCH | fails   | GITHUB_LOGIN_MISMATCH |

    Scenario: A job that reports nothing fails the sync
      Given the command "bun bootstrap/worker-github.ts --node worker-one" fails
      When the GitHub sign-in of "worker-one" is converged
      Then the check "github:sync" fails
      And the check "github:sync" says "GITHUB_SYNC_UNREPORTED"

    Scenario: The job's unit allows every step its full time
      A unit that kills the job before its steps can time out leaves no
      result at all.
      When the GitHub sign-in unit of a worker is read
      Then it allows each of 5 steps its full timeout, and the runtime its start
      And it runs "bootstrap/worker-github.ts" every 10 minutes
      And the Vault renewal unit does not run it
