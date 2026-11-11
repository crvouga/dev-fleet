Feature: A worker says how its monitoring agent stands, from its own side
  Before the agent is installed, the worker measures that its disk has room
  for it; a full disk is named as such, and nothing is installed. Afterwards,
  the agent's own log says how the hub answered it: connected, a token the hub
  does not know, a hub that did not prove its key, or a hub that is down
  behind its private route. Only fixed texts the pinned agent logs are
  matched, and nothing of the log is reported: it names hosts.

  Background:
    Given the example fleet, whose manager "manager-mac" is reached at "manager-mac-1.tail0a1b2c.ts.net" and serves the hub on port 8443
    And these commands answer:
      | command                                     | answer                                                                                                                                 |
      | git rev-parse HEAD                          | prints aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa                                                                                        |
      | git rev-parse --show-toplevel               | prints /fleet/checkout                                                                                                                 |
      | git status --porcelain                      | succeeds                                                                                                                               |
      | df -Pk /usr/local/lib /var/lib              | prints Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 50000000 50000000 50% /\n/dev/sda1 100000000 50000000 50000000 50% / |
      | systemctl is-enabled beszel-agent.service   | succeeds                                                                                                                               |
      | systemctl is-active beszel-agent.service    | succeeds                                                                                                                               |
    And the playbook "agent.yml" succeeds
    And no apply leaves a receipt

  Rule: A full disk is named before anything is installed

    Scenario: A disk without room for the agent stops the installation
      Given the command "df -Pk /usr/local/lib /var/lib" prints Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 99900000 100000 100% /\n/dev/sda1 100000000 99900000 100000 100% /
      When the worker "worker-one" installs its agent for the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then the check fails with "BESZEL_DISK_FULL"
      And the remedy of the check contains "97 MiB"
      And the playbook "agent.yml" was not run

    Scenario: A disk that cannot be measured stops the installation too
      Given the command "df -Pk /usr/local/lib /var/lib" fails
      When the worker "worker-one" installs its agent for the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then the check fails with "BESZEL_DISK_UNVERIFIED"
      And the playbook "agent.yml" was not run

  Rule: The agent's newest connection outcome is reported, and nothing of its log

    Scenario Outline: An agent whose log ends with <logged> is reported as "<status>"
      Given the command "sudo -n journalctl --unit=beszel-agent.service --output=cat --no-pager --lines=200" prints <log>
      When the worker "worker-one" installs its agent for the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then these checks are reported:
        | check                 | status   |
        | beszel:disk           | pass     |
        | beszel:service        | pass     |
        | beszel:hub-connection | <status> |
      And the summary of the third check is "<summary>"
      And the checks do not contain "manager-mac-1"

      Examples:
        | logged                         | log                                                                                                                                       | status | summary                                                  |
        | connected                      | WARN WebSocket connection failed err="unexpected status code: 502"\nINFO WebSocket connected host=manager-mac-1.tail0a1b2c.ts.net:8443  | pass   | The agent is connected to the hub, which proved its key. |
        | a refused token                | INFO WebSocket connected host=manager-mac-1.tail0a1b2c.ts.net:8443\nWARN WebSocket connection failed err="unexpected status code: 401"  | fail   | BESZEL_AGENT_TOKEN_REJECTED                              |
        | a hub that did not prove its key | ERROR Error handling message err="invalid signature - check KEY value"                                                                  | fail   | BESZEL_AGENT_KEY_REJECTED                                |
        | a hub down behind its route    | WARN WebSocket connection failed err="unexpected status code: 503"                                                                        | warn   | BESZEL_HUB_UNAVAILABLE_TO_AGENT                          |
        | no attempt yet                 | INFO Data directory path=/var/lib/beszel-agent                                                                                            | skip   | BESZEL_AGENT_CONNECTION_PENDING                          |

    Scenario: An agent log that cannot be read leaves the outcome unknown, not failed
      Given the command "sudo -n journalctl --unit=beszel-agent.service --output=cat --no-pager --lines=200" fails
      When the worker "worker-one" installs its agent for the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then the summary of the third check is "BESZEL_AGENT_LOG_UNAVAILABLE"
      And the third check is skipped

    Scenario: A stopped agent reports no connection outcome
      Given the command "systemctl is-active beszel-agent.service" fails
      When the worker "worker-one" installs its agent for the hub "https://manager-mac-1.tail0a1b2c.ts.net:8443"
      Then these checks are reported:
        | check          | status |
        | beszel:disk    | pass   |
        | beszel:service | fail   |
      And no command with the word "journalctl" was run
