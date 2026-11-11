Feature: The manager says whether the hub's own backups would survive losing it
  The hub keeps history, settings and every machine's identity. Its backups
  are configured in the hub's own UI (Settings > Backups); fleet-sync only
  reads them, as the hub's superuser, through the two stock API requests of
  the pinned release. A backup that stays on the manager's disk is not
  disaster recovery. Every outcome but a recent off-host backup is a warning:
  it never blocks the fleet. Storage names, keys and endpoints are never
  reported.

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
    And the remedy of the check contains "Settings > Backups"

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
