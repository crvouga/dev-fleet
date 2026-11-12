Feature: The manager says whether the hub's own backups would survive losing it
  The hub keeps history, settings and every machine's identity. fleet-sync
  sets its scheduled backups from the fleet configuration
  (services.monitoring.backups) through the hub's API, and reads them back as
  the hub's superuser through the two stock API requests of the pinned
  release. A backup that stays on the manager's disk is not disaster
  recovery. Without declared backups every outcome but a recent off-host
  backup is a warning; with them, anything but what is declared fails, and a
  stale backup fails after a grace period of a week. Storage names, keys and
  endpoints are never reported.

  Background:
    Given the manager's clock reads "2026-11-06T12:00:00Z"
    And the hub on the manager answers its superuser:
      | request       | answer                                                                                                                                                  |
      | /api/settings | {"backups":{"cron":"0 3 * * *","cronMaxKeep":7,"s3":{"enabled":true,"bucket":"never-output-bucket","endpoint":"https://never-output.example","accessKey":"never-output-key"}}} |
      | /api/backups  | [{"key":"never-output-name.zip","size":1024,"modified":"2026-11-06 03:00:01.000Z"}]                                                                     |

  Scenario: Scheduled, off-host and recent backups pass, and nothing about the storage is repeated
    When the hub's backups are read with the fleet login "fleet@example.test"
    Then the check passes
    And the summary of the check is "Scheduled backups go to off-host storage, keeping 7; the newest is from 2026-11-06T03:00:01.000Z."
    And the checks do not contain "never-output"
    And the hub was asked exactly, in order:
      | POST /api/collections/_superusers/auth-with-password |
      | GET /api/settings                                    |
      | GET /api/backups                                     |

  Scenario Outline: Backups that are <how> warn with <summary>
    Given the hub on the manager answers its superuser:
      | request       | answer     |
      | /api/settings | <settings> |
      | /api/backups  | <backups>  |
    When the hub's backups are read with the fleet login "fleet@example.test"
    Then the check warns
    And the summary of the check is "<summary>"
    And the remedy of the check contains "services.monitoring.backups"

    Examples:
      | how                    | settings                                                          | backups                                                         | summary                        |
      | not scheduled          | {"backups":{"cron":"","cronMaxKeep":3,"s3":{"enabled":true}}}     | []                                                              | BESZEL_BACKUP_UNSCHEDULED      |
      | kept on the manager    | {"backups":{"cron":"0 3 * * *","cronMaxKeep":3,"s3":{"enabled":false}}} | [{"key":"a.zip","size":1,"modified":"2026-11-06 03:00:01.000Z"}] | BESZEL_BACKUP_OFFHOST_REQUIRED |
      | older than two days    | {"backups":{"cron":"0 3 * * *","cronMaxKeep":3,"s3":{"enabled":true}}}  | [{"key":"a.zip","size":1,"modified":"2026-11-04 03:00:00.000Z"}] | BESZEL_BACKUP_STALE            |
      | scheduled but none yet | {"backups":{"cron":"0 3 * * *","cronMaxKeep":3,"s3":{"enabled":true}}}  | []                                                              | BESZEL_BACKUP_STALE            |
      | in an unknown form     | {"smtp":{}}                                                       | []                                                              | BESZEL_BACKUP_UNVERIFIED       |

  Scenario: A hub that refuses the login is a warning, without what it answered
    Given the hub on the manager refuses every request with "never-output-detail"
    When the hub's backups are read with the fleet login "fleet@example.test"
    Then the check warns
    And the summary of the check is "BESZEL_BACKUP_UNVERIFIED"
    And the checks do not contain "never-output"

  Scenario: Without the fleet login nothing is asked
    When the hub's backups are read without a fleet login
    Then the summary of the check is "BESZEL_BACKUP_UNVERIFIED"
    And the check is skipped
    And the hub was not asked anything

  Rule: Backups the fleet configuration declares fail when they are not what it says

    Background:
      Given the fleet configuration declares hub backups at "0 3 * * *", keeping 7

    Scenario Outline: Declared backups that are <how> are <verdict> with <summary>
      Given the hub on the manager answers its superuser:
        | request       | answer     |
        | /api/settings | <settings> |
        | /api/backups  | <backups>  |
      When the hub's backups are read with the fleet login "fleet@example.test"
      Then the check <verdict>
      And the summary of the check is "<summary>"
      And the remedy of the check contains "monitoring-backup-secret-key"

      Examples:
        | how                         | settings                                                                | backups                                                          | verdict | summary                        |
        | not scheduled               | {"backups":{"cron":"","cronMaxKeep":7,"s3":{"enabled":true}}}           | []                                                               | fails   | BESZEL_BACKUP_UNSCHEDULED      |
        | kept on the manager         | {"backups":{"cron":"0 3 * * *","cronMaxKeep":7,"s3":{"enabled":false}}} | [{"key":"a.zip","size":1,"modified":"2026-11-06 03:00:01.000Z"}] | fails   | BESZEL_BACKUP_OFFHOST_REQUIRED |
        | on another schedule         | {"backups":{"cron":"0 4 * * *","cronMaxKeep":7,"s3":{"enabled":true}}}  | [{"key":"a.zip","size":1,"modified":"2026-11-06 03:00:01.000Z"}] | fails   | BESZEL_BACKUP_NOT_CONVERGED    |
        | three days old              | {"backups":{"cron":"0 3 * * *","cronMaxKeep":7,"s3":{"enabled":true}}}  | [{"key":"a.zip","size":1,"modified":"2026-11-03 03:00:00.000Z"}] | warns   | BESZEL_BACKUP_STALE            |
        | eight days old              | {"backups":{"cron":"0 3 * * *","cronMaxKeep":7,"s3":{"enabled":true}}}  | [{"key":"a.zip","size":1,"modified":"2026-10-29 03:00:00.000Z"}] | fails   | BESZEL_BACKUP_STALE            |
        | not taken yet on a new hub  | {"backups":{"cron":"0 3 * * *","cronMaxKeep":7,"s3":{"enabled":true}}}  | []                                                               | warns   | BESZEL_BACKUP_STALE            |

    Scenario: Declared, scheduled, off-host and recent backups pass
      When the hub's backups are read with the fleet login "fleet@example.test"
      Then the check passes

  Rule: fleet-sync hands the declared backups to the hub's playbook, with the storage keys from the secrets

    Scenario: The schedule, the storage and its two keys reach the playbook's variables
      Given the secret store holds "PRIVATE_ACCESS_KEY" for "beszel/backups" "ACCESS_KEY_ID"
      And the secret store holds "PRIVATE_SECRET_KEY" for "beszel/backups" "SECRET_ACCESS_KEY"
      When the hub's backup variables are prepared from the example fleet configuration
      Then the hub's backup variables are:
        | beszel_backup_schedule         | 0 3 * * *              |
        | beszel_backup_keep             | 7                      |
        | beszel_backup_bucket           | my-fleet-hub-backups   |
        | beszel_backup_endpoint         | https://s3.example.com |
        | beszel_backup_region           | auto                   |
        | beszel_backup_force_path_style | false                  |
        | beszel_backup_access_key       | PRIVATE_ACCESS_KEY     |
        | beszel_backup_secret_key       | PRIVATE_SECRET_KEY     |
      And no command contains "PRIVATE_"

    Scenario: Without both keys nothing is handed over, and beszel:backup says why
      Given the secret store holds "PRIVATE_ACCESS_KEY" for "beszel/backups" "ACCESS_KEY_ID"
      When the hub's backup variables are prepared from the example fleet configuration
      Then no backup variables are handed over
