Feature: Only a failed configuration stops promotion past the canary
  Acceptance of a service or an account stays required for a worker to be
  ready, but a missing external account, dashboard or client pairing must not
  stop independent configuration of the other workers. Neither does a T3
  outcome that waits for an operator's maintenance window: routine sync never
  kills an active listener or a running release. A deployment that failed
  does stop promotion.

  Scenario Outline: "<summary>" on "<check>" leaves promotion <promotion>
    When the canary reports the check "<check>" as "<status>" with the summary "<summary>"
    Then promotion to the other workers is <promotion>

    Examples: Maintenance, external accounts and pairing
      | check              | status | summary                           | promotion |
      | t3:service         | fail   | T3_LISTENER_CONFLICT              | allowed   |
      | t3:service         | fail   | T3_MAINTENANCE_REQUIRED           | allowed   |
      | ubuntu:boot-policy | fail   | UBUNTU_MAINTENANCE_REBOOT_PENDING | allowed   |
      | beszel:enrollment  | fail   | BESZEL_ACCOUNT_REQUIRED           | allowed   |
      | t3:paired-access   | fail   | MANAGER_T3_LINK_UNVERIFIED        | allowed   |

    Examples: Configuration that failed
      | check                    | status | summary                         | promotion |
      | t3:service               | fail   | T3_SERVICE_INSTALLATION_FAILED  | blocked   |
      | ubuntu:baseline          | fail   | UBUNTU_BASELINE_INCOMPLETE      | blocked   |
      | workstation:installation | fail   | WORKSTATION_INSTALLATION_FAILED | blocked   |

    Examples: A check that passed
      | check           | status | summary | promotion |
      | ubuntu:baseline | pass   | ok      | allowed   |
