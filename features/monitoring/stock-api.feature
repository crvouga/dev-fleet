Feature: Monitoring uses only the stock API of the pinned hub
  The hub is the stock Beszel release ansible/monitoring/lock.json pins, on
  the PocketBase release that ships inside it. Monitoring reads and enrolls
  through the API that release serves, and nothing else: there is no custom
  endpoint, reconciler or database edit. Settings the hub keeps only in its UI
  (network monitors, alert thresholds, backups) are documented there and only
  read back. These paths were checked against the sources of Beszel 0.21.1
  and PocketBase 0.40.5.

  Scenario: Every hub API path the monitoring code names is a stock one
    When the hub API paths named under "src/monitoring" and in "src/cli/managed-health.ts" are listed
    Then they are exactly:
      | /api/backups                                    |
      | /api/beszel/info                                |
      | /api/collections/_superusers/auth-with-password |
      | /api/collections/fingerprints/records           |
      | /api/collections/system_stats/records           |
      | /api/collections/systems/records                |
      | /api/collections/users/auth-with-password       |
      | /api/collections/users/records                  |
      | /api/health                                     |
      | /api/settings                                   |
