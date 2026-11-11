Feature: A worker's no-sleep policy has to survive a reboot
  A worker never sleeps and keeps its user's processes after logout. That is
  accepted from what the running login manager exposes, not from an installer
  receipt, and only when the managed power files were written before this
  boot: a policy staged since the last boot has not been through a reboot yet.

  Background:
    Given these commands answer:
      | command                                                            | answer                         |
      | busctl get-property … HandleLidSwitch                              | prints s "ignore"              |
      | busctl get-property … HandleLidSwitchDocked                        | prints s "ignore"              |
      | busctl get-property … HandleLidSwitchExternalPower                 | prints s "ignore"              |
      | busctl get-property … IdleAction                                   | prints s "ignore"              |
      | busctl get-property … KillUserProcesses                            | prints b false                 |
      | busctl get-property … StopIdleSessionUSec                          | prints t 18446744073709551615  |
      | systemctl is-enabled …                                             | fails printing masked          |
      | loginctl show-user fixture --property=Linger --value               | prints yes                     |
      | cat /proc/stat                                                     | prints cpu 1 2 3\nbtime 2000\n |
      | stat --format=%Y /etc/systemd/logind.conf.d/60-personal-fleet.conf | prints 1000                    |
      | stat --format=%Y /etc/systemd/sleep.conf.d/60-personal-fleet.conf  | prints 1000                    |

  Scenario: Running policy and power files older than the boot are accepted
    When the boot policy of the worker is measured for the user "fixture"
    Then the check passes

  Scenario Outline: <what is observed> is reported as <summary>
    A running login manager with the old policy needs a maintenance reboot
    and is never restarted during sessions. A sleep transition that is no
    longer masked is drift, whatever an earlier apply recorded.
    Given the command "<command>" <answer>
    When the boot policy of the worker is measured for the user "fixture"
    Then the summary of the check is "<summary>"

    Examples:
      | what is observed                       | command                               | answer             | summary                           |
      | A policy staged after this boot        | stat --format=%Y …                    | prints 3000        | UBUNTU_MAINTENANCE_REBOOT_PENDING |
      | A login manager running the old policy | busctl get-property … HandleLidSwitch | prints s "suspend" | UBUNTU_SESSION_POLICY_PENDING     |
      | A sleep transition that is not masked  | systemctl is-enabled …                | prints static      | UBUNTU_SLEEP_POLICY_DRIFT         |
