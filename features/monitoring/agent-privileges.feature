Feature: The agent sees what an unprivileged service may see, and no more
  The native agent runs as its own system account, sandboxed by systemd. It
  is given no group, capability, journal or Docker socket, so service logs and
  containers stay unreadable to it, and the metrics that need them stay
  unavailable rather than being granted by default. The agent connects out to
  the hub; it opens no SSH server of its own.

  Scenario: The agent's unit grants no extra privilege
    When the agent's systemd unit "ansible/monitoring/beszel-agent.service" is read
    Then it runs as the user "beszel" in the group "beszel"
    And it sets each of these:
      | NoNewPrivileges=true                     |
      | ProtectSystem=strict                     |
      | ProtectHome=true                         |
      | PrivateTmp=true                          |
      | RestrictSUIDSGID=true                    |
      | Environment=SKIP_SYSTEMD_LOGS=true       |
      | Environment=DISABLE_SSH=true             |
    And it names none of these:
      | SupplementaryGroups |
      | AmbientCapabilities |
      | CapabilityBoundingSet=CAP_ |
      | systemd-journal     |
      | docker.sock         |
      | DOCKER_HOST         |
      | User=root           |

  Scenario: The agent's account belongs to no group but its own
    When the task "Create unprivileged service account" of "ansible/monitoring/agent.yml" is read
    Then it creates a system account without a login shell
    And it adds the account to no other group
