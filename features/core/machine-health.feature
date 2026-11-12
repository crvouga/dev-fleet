# ␊ stands for a line break.
Feature: The health of a machine itself
  Besides its services, a machine can fail on its own: its disk runs out of
  inodes, its clock drifts, its updates wait for a reboot, its Tailscale key
  expires, or the manager falls behind on macOS. Each is measured by commands
  that only read, and a check that does not pass says what to do.

  Rule: A worker short of inodes fails, although bytes are free

    Scenario Outline: A worker with <inodes>% of its inodes free <verdict>
      Given every command prints:
        """
        ncpu=4
        load=0.5
        memfree=50
        swap=0
        diskmb=50000
        inodefree=<inodes>
        ntp=1
        ntpsync=1
        """
      When the capacity of the worker is checked
      Then the check "worker:capacity:inodes" <verdict>
      And the check "worker:capacity:disk" passes

      Examples:
        | inodes | verdict |
        | 40     | passes  |
        | 5      | warns   |
        | 0      | fails   |

    Scenario: Exhausted inodes are named, with a remedy
      Given every command prints:
        """
        ncpu=4
        load=0.5
        memfree=50
        swap=0
        diskmb=50000
        inodefree=0
        """
      When the capacity of the worker is checked
      Then the summary of the check "worker:capacity:inodes" mentions "INODES_EXHAUSTED"
      And the remedy of the check "worker:capacity:inodes" mentions "dependency trees"

  Rule: A worker's clock is synchronised to a time source and close to the manager's

    Scenario Outline: A worker whose time service is <service> and clock <state> <verdict>
      Given every command prints:
        """
        ncpu=4
        load=0.5
        memfree=50
        swap=0
        diskmb=50000
        ntp=<ntp>
        ntpsync=<synced>
        epoch=<epoch>
        """
      When the capacity of the worker is checked against the manager's clock at 1800000000
      Then the check "worker:clock" <verdict>
      And the summary of the check "worker:clock" mentions "<summary>"

      Examples:
        | service  | state                    | ntp | synced | epoch      | verdict | summary                |
        | enabled  | synchronised             | 1   | 1      | 1800000001 | passes  | synchronised           |
        | enabled  | 10 s ahead               | 1   | 1      | 1800000010 | warns   | CLOCK_DRIFTING         |
        | enabled  | not yet synchronised     | 1   | 0      | 1800000000 | warns   | CLOCK_NOT_SYNCHRONISED |
        | disabled | skewed by 100 s          | 0   | 0      | 1800000100 | fails   | CLOCK_SKEWED           |
        | disabled | never synchronised       | 0   | 0      | 1800000000 | fails   | CLOCK_NOT_SYNCHRONISED |

    Scenario: A worker with no time service and a skewed clock is told to enable one
      Given every command prints:
        """
        ncpu=4
        load=0.5
        memfree=50
        swap=0
        diskmb=50000
        ntp=0
        ntpsync=0
        epoch=1800000100
        """
      When the capacity of the worker is checked against the manager's clock at 1800000000
      Then the check "worker:clock" fails
      And the remedy of the check "worker:clock" mentions "systemd-timesyncd"

  Rule: A pending reboot is reported with its age, and fails once it is old

    Scenario: A worker with nothing pending passes
      When a worker with no pending reboot is checked
      Then the check "worker:reboot-pending" passes

    Scenario Outline: A reboot pending for <days> days <verdict>
      Given the command "stat" prints "<since>"
      When the pending reboot of the worker is checked on "2026-11-20T00:00:00Z"
      Then the check "worker:reboot-pending" <verdict>
      And the summary of the check "worker:reboot-pending" mentions "REBOOT_PENDING for <days> days"
      And the remedy of the check "worker:reboot-pending" mentions "no agent turn is running"

      Examples:
        | days | since      | verdict |
        | 3    | 1794870000 | warns   |
        | 19   | 1793487600 | fails   |

    Scenario: A pending reboot of unknown age warns
      Given every command fails
      When the pending reboot of the worker is checked on "2026-11-20T00:00:00Z"
      Then the check "worker:reboot-pending" warns

  Rule: A Tailscale node key is renewed before it expires

    Background:
      Given Tailscale is running and lists these machines:
        | machine      | ID       | HostName | DNSName                  | OS    | Online | TailscaleIPs |
        | this machine | manager  | manager  | manager.tailnet.ts.net.  | macOS | true   | 100.64.0.1   |
        | peer         | worker-a | worker-a | worker-a.tailnet.ts.net. | linux | true   | 100.64.0.2   |
      And Tailscale reports no health problem

    Scenario Outline: A key that expires on <expiry> <verdict> on 2026-11-11
      Given Tailscale reports the "KeyExpiry" of the peer "worker-a" as "<expiry>"
      When the Tailscale key of the computer "worker-a" is checked on "2026-11-11T00:00:00Z"
      Then the check "tailscale:key-expiry" <verdict>
      And the summary of the check "tailscale:key-expiry" mentions "<summary>"

      Examples:
        | expiry               | verdict | summary                            |
        | 2027-05-01T00:00:00Z | passes  | expires in 171 days                |
        | 2026-11-21T00:00:00Z | warns   | TAILSCALE_KEY_EXPIRES_SOON in 10 days |
        | 2026-11-13T00:00:00Z | fails   | TAILSCALE_KEY_EXPIRES_SOON in 2 days  |
        | 2026-11-01T00:00:00Z | fails   | TAILSCALE_KEY_EXPIRED              |
        | 0001-01-01T00:00:00Z | passes  | does not expire                    |

    Scenario: A worker key that expires in 10 days says how to keep it
      Given Tailscale reports the "KeyExpiry" of the peer "worker-a" as "2026-11-21T00:00:00Z"
      When the Tailscale key of the computer "worker-a" is checked on "2026-11-11T00:00:00Z"
      Then the remedy of the check "tailscale:key-expiry" mentions "Disable key expiry for the worker"
      And the remedy of the check "tailscale:key-expiry" mentions "re-join"

    Scenario: A key Tailscale does not mention never expires
      When the Tailscale key of the computer "manager" is checked on "2026-11-11T00:00:00Z"
      Then the check "tailscale:key-expiry" passes

  Rule: The manager runs a supported macOS with its updates installed and room on its disk

    Background:
      Given these commands print:
        | command        | prints                                                                                  |
        | sw_vers        | 15.1                                                                                    |
        | softwareupdate | No new software available.                                                              |
        | df             | Filesystem 1024-blocks Used Available Capacity Mounted␊/dev/disk3s5 1 1 104857600 1% /x |
        | docker         | 10GB␊1.5GB␊0B␊500MB                                                                     |
        | cat            | {}                                                                                      |

    Scenario: A manager with nothing to do passes every check
      When the health of the manager is checked
      Then every check passes
      And the summary of the check "manager:disk" mentions "Docker holds 11.2 GiB"

    Scenario Outline: A manager with <situation> <verdict> "<check>"
      Given these commands print:
        | command   | prints   |
        | <command> | <prints> |
      When the health of the manager is checked
      Then the check "<check>" <verdict>
      And the summary of the check "<check>" mentions "<summary>"
      And the check "<check>" has a remedy

      Examples:
        | situation                    | check           | command        | prints                                                                                                                                | verdict | summary                    |
        | macOS 13                     | manager:release | sw_vers        | 13.6.1                                                                                                                                | fails   | MANAGER_RELEASE_UNSUPPORTED |
        | an update pending            | manager:updates | softwareupdate | Software Update found the following new or updated software:␊* Label: Safari-PRIVATE␊ Title: Safari, Recommended: YES,                   | warns   | MANAGER_UPDATES_PENDING 1  |
        | an update waiting to restart | manager:updates | softwareupdate | Software Update found the following new or updated software:␊* Label: macOS-PRIVATE␊ Title: macOS, Recommended: YES, Action: restart, | warns   | MANAGER_RESTART_PENDING    |
        | 2 GiB free                   | manager:disk    | df             | Filesystem 1024-blocks Used Available Capacity Mounted␊/dev/disk3s5 1 1 2097152 99% /x                                                 | fails   | MANAGER_DISK_FULL          |
        | 10 GiB free                  | manager:disk    | df             | Filesystem 1024-blocks Used Available Capacity Mounted␊/dev/disk3s5 1 1 10485760 90% /x                                                | warns   | MANAGER_DISK_LOW           |
        | 80 GB in Docker              | manager:disk    | docker         | 80GB                                                                                                                                  | warns   | MANAGER_DOCKER_DISK_LARGE  |

    Scenario: The names of pending updates are never reported
      Given these commands print:
        | command        | prints                                                                                |
        | softwareupdate | Software Update found the following new or updated software:␊* Label: Safari-PRIVATE |
      When the health of the manager is checked
      Then nothing reported contains "PRIVATE"

  Rule: A container that stays unhealthy is restarted, a bounded number of times an hour
    Docker restarts a container that exits, never one that hangs while it
    still holds its port. The watchdog on the manager restarts one that was
    unhealthy for 3 checks in a row, at most 3 times an hour.

    Scenario Outline: A container whose health was <seen> is <outcome>
      When the watchdog has seen the container "proxy" as <seen>, having restarted it <restarts> times in the last hour
      Then the watchdog <outcome>

      Examples:
        | seen                                  | restarts | outcome                          |
        | unhealthy, unhealthy                  | 0        | restarts nothing                 |
        | unhealthy, unhealthy, unhealthy       | 0        | restarts "proxy", "unhealthy for 3 checks" |
        | unhealthy, healthy, unhealthy         | 0        | restarts nothing                 |
        | starting, starting, starting          | 0        | restarts nothing                 |
        | unhealthy, unhealthy, unhealthy       | 3        | restarts nothing and caps "proxy" |

    Scenario Outline: The manager reports a container the watchdog <did>
      Given the container watchdog remembers '<memory>', where NOW is the time now
      When the health of the manager is checked
      Then the check "manager:container-watchdog" <verdict>
      And the summary of the check "manager:container-watchdog" mentions "<summary>"

      Examples:
        | did                     | memory                                                    | verdict | summary                       |
        | never had to restart    | {"proxy":{"unhealthy":0,"restarts":[],"capped":null}}     | passes  | No container                  |
        | restarted just now      | {"proxy":{"unhealthy":0,"restarts":[NOW],"capped":null}}  | warns   | CONTAINER_RESTARTED_UNHEALTHY proxy |
        | stopped restarting      | {"proxy":{"unhealthy":5,"restarts":[NOW],"capped":NOW}}   | fails   | CONTAINER_RESTART_STORM proxy |
