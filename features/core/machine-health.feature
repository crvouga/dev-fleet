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

  Rule: The manager measures each worker's clock against its own
    fleet-sync reads the worker's clock on the last line of the same SSH
    probe that reads its release and its size. The worker read it somewhere
    between the moment the manager sent the probe and the moment the answer
    came back, so only the smallest
    offset that window allows is judged: a slow link never reads as a skewed
    clock.

    Scenario Outline: A worker whose clock read <worker> while the manager's went from <sent> to <received> <verdict>
      Given every command prints:
        """
        ubuntu
        26.04
        x86_64
        machine
        kvm
        4
        16384
        102400
        <worker>
        """
      When the manager inspects the worker, its own clock reading <sent> when it sends the probe and <received> when the answer comes back
      Then the check "worker:clock-offset" <verdict>
      And the summary of the check "worker:clock-offset" mentions "<summary>"

      Examples:
        | worker               | sent       | received   | verdict | summary                       |
        | 1800000000.500000000 | 1800000000 | 1800000001 | passes  | within 2 s of the manager's   |
        | 1800000025           | 1800000000 | 1800000030 | passes  | within 2 s of the manager's   |
        | 1800000004.5         | 1800000000 | 1800000001 | warns   | CLOCK_DRIFTING 3.5 s ahead of |
        | 1799999960           | 1800000000 | 1800000001 | fails   | CLOCK_SKEWED 40.0 s behind    |

    Scenario: A worker that prints no clock is not judged on it
      Given every command prints:
        """
        ubuntu
        26.04
        x86_64
        machine
        """
      When the manager inspects the worker, its own clock reading 1800000000 when it sends the probe and 1800000001 when the answer comes back
      Then there is no check "worker:clock-offset"

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

  Rule: The manager runs a supported macOS with its updates installed, room on its disk, network time and its watch job

    Background:
      Given these commands print:
        | command        | prints                                                                                  |
        | sw_vers        | 15.1                                                                                    |
        | softwareupdate | No new software available.                                                              |
        | df             | Filesystem 1024-blocks Used Available Capacity Mounted␊/dev/disk3s5 1 1 104857600 1% /x |
        | docker         | 10GB␊1.5GB␊0B␊500MB                                                                     |
        | cat            | {}                                                                                      |
        | sudo -n /usr/sbin/systemsetup | Network Time: On |
        | /bin/launchctl print gui/501/dev.devfleet.fleet-watch | state = not running |
        | cat /etc/newsyslog.d/dev-fleet-dev.conf | # Managed by dev-fleet: manager job logs␊/Users/dev/.local/share/personal/fleet/manager/logs/personal-fleet-sync.out.log dev:staff 600 3 1024 * NZ␊/Users/dev/.local/share/personal/fleet/manager/logs/personal-fleet-sync.err.log dev:staff 600 3 1024 * NZ␊/Users/dev/.local/share/personal/fleet/manager/logs/dev.devfleet.fleet-watch.out.log dev:staff 600 3 1024 * NZ␊/Users/dev/.local/share/personal/fleet/manager/logs/dev.devfleet.fleet-watch.err.log dev:staff 600 3 1024 * NZ |

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

    Scenario: A manager whose clock is off network time fails, and is told how to turn it on
      Given the command "sudo -n /usr/sbin/systemsetup" prints "Network Time: Off"
      When the health of the manager is checked
      Then the check "manager:clock" fails
      And the summary of the check "manager:clock" mentions "MANAGER_CLOCK_NOT_SYNCHRONISED"
      And the remedy of the check "manager:clock" mentions "Date & Time"

    Scenario: Without the grant the manager's clock is not read, and the grant is named
      Given the command "sudo -n /usr/sbin/systemsetup" fails
      When the health of the manager is checked
      Then the check "manager:clock" warns
      And the summary of the check "manager:clock" mentions "MANAGER_CLOCK_UNOBSERVED"
      And the remedy of the check "manager:clock" mentions "manager-privilege.yml"

    Scenario: A manager whose watch job is not loaded fails: no heartbeat reaches the bucket
      Given the command "/bin/launchctl print gui/501/dev.devfleet.fleet-watch" fails
      When the health of the manager is checked
      Then the check "manager:watch" fails
      And the summary of the check "manager:watch" mentions "MANAGER_WATCH_NOT_LOADED"
      And the remedy of the check "manager:watch" mentions "devfleet fleet-sync"

    Scenario: A watch job whose last run failed warns, and points at its log
      Given the command "/bin/launchctl print gui/501/dev.devfleet.fleet-watch" prints "state = not running␊last exit code = 1"
      When the health of the manager is checked
      Then the check "manager:watch" warns
      And the summary of the check "manager:watch" mentions "MANAGER_WATCH_FAILING exit 1"
      And the remedy of the check "manager:watch" mentions "dev.devfleet.fleet-watch.err.log"

    Scenario: A rotation that misses a log of a scheduled job is not in place
      Given the command "cat /etc/newsyslog.d/dev-fleet-dev.conf" prints "# Managed by dev-fleet: manager job logs␊/Users/dev/.local/share/personal/fleet/manager/logs/personal-fleet-sync.out.log dev:staff 600 3 1024 * NZ"
      When the health of the manager is checked
      Then the check "manager:job-logs" warns
      And the summary of the check "manager:job-logs" mentions "MANAGER_JOB_LOG_ROTATION_MISSING"

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
