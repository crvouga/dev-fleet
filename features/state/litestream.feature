Feature: The pinned Litestream replicates the fleet state and a new manager restores it
  These scenarios run the Litestream that mise.toml pins, against a directory
  and against a throwaway S3 service: no machine and no real bucket. They are
  skipped where the toolchain is not installed or DEVFLEET_TEST_S3 names no
  service. Where DEVFLEET_TEST_LITESTREAM is "required" (the Fleet state job
  in CI) nothing is skipped: a missing piece fails.

  @required
  Scenario: Where these checks are required, nothing they need is missing
    Then the pinned Litestream is installed
    And DEVFLEET_TEST_S3 names an S3 service

  @litestream @slow
  Rule: Litestream replicates the state database to a directory and a new manager restores it

    Background:
      Given managers "a" and "b" replicate to one directory with the pinned Litestream

    Scenario: A fleet nobody has written to is empty
      When manager "a" compares its copy with the bucket
      Then it reports "empty"

    Scenario: Every change is replicated
      When manager "a" makes these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      Then every change reports "in-sync"

    Scenario: A manager that has never seen the fleet gets all of it from the bucket
      Given manager "a" made these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      When manager "b" refreshes its copy
      Then the refresh reports "in-sync" and a replaced copy
      And the fleet state of manager "b" holds the configuration "three"

    Scenario: The new manager continues the same history
      Given manager "a" made these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      And manager "b" refreshed its copy
      When manager "b" changes the configuration to "four"
      Then it reports "in-sync"
      And manager "a" stands "bucket-ahead" with the bucket

    Scenario: The first manager follows it
      Given manager "a" made these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      And manager "b" refreshed its copy
      And manager "b" changed the configuration to "four"
      When manager "a" restores its copy from the bucket
      Then it reports "in-sync"
      And the fleet state of manager "a" holds the configuration "four"

    Scenario: The first manager changes the state again
      Given manager "a" made these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      And manager "b" refreshed its copy
      And manager "b" changed the configuration to "four"
      And manager "a" restored its copy from the bucket
      When manager "a" changes the configuration to "five"
      Then it reports "in-sync"

    Scenario: The new manager follows in turn
      Given manager "a" made these changes to the configuration in turn:
        | one   |
        | two   |
        | three |
      And manager "b" refreshed its copy
      And manager "b" changed the configuration to "four"
      And manager "a" restored its copy from the bucket
      And manager "a" changed the configuration to "five"
      When manager "b" refreshes its copy
      Then its copy was replaced
      And the fleet state of manager "b" holds the configuration "five"

  @litestream @slow
  Rule: Two managers and a damaged replica, with the pinned Litestream

    Background:
      Given managers "a" and "b" replicate to one directory with the pinned Litestream

    Scenario: A second writer is refused before it writes
      Given managers "a" and "b" are told apart by the manager lease
      And manager "a" changed the configuration to "from a"
      When manager "b" changes the configuration to "from b"
      Then it is refused with "FLEET_MANAGER_LEASE_HELD"
      And manager "b" has nothing waiting for the bucket
      And the fleet state of manager "b" holds the configuration "from a"

    Scenario: The version the bucket held at an earlier time is restored and read
      Given manager "a" changed the configuration to "one"
      And a second passed
      And the time was noted
      And a second passed
      And manager "a" changed the configuration to "two"
      When manager "b" restores the version the bucket held at the noted time
      Then it reports "in-sync"
      And the fleet state of manager "b" holds the configuration "one"
      And manager "a" stands "bucket-ahead" with the bucket

  @litestream @s3 @slow
  Rule: fleet-state keeps a fleet in an S3 bucket
    In a command, `$S3` is the origin DEVFLEET_TEST_S3 names, `$S3_BUCKET` is a
    bucket made there for the scenario, `~` is the manager's home and
    examples/fleet.json is the tracked example.

    Background:
      Given a new bucket on the S3 service
      And managers "a" and "b" run the pinned Litestream
      And commands on manager "a" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |
      And commands on manager "b" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |

    Scenario: The bucket is connected
      When the operator runs "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "a"
      Then the S3 service made the new bucket
      And the command exits 0

    Scenario: The database is in the bucket under this fleet's prefix only, and the keys are kept in bucket.json alone
      Given the operator ran "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "a"
      When the operator runs "fleet-state --import examples/fleet.json" on manager "a"
      Then the report includes:
        """
        { "standing": "in-sync", "ok": true }
        """
      And the new bucket holds objects, every one under "fleets/one/fleet.db/"
      And "litestream.yml" in the state directory of manager "a" does not contain "test-secret-access-key"
      And the bucket.json of manager "a" contains "test-secret-access-key"
      And nothing the command returned contains "test-secret-access-key"

  @litestream @s3 @slow
  Rule: A replacement manager restores the fleet from the S3 bucket
    It brings only the bucket's location and keys.

    Background:
      Given a new bucket on the S3 service
      And managers "a" and "b" run the pinned Litestream
      And commands on manager "a" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |
      And commands on manager "b" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |
      And the operator ran "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "a"
      And the operator ran "fleet-state --import examples/fleet.json" on manager "a"

    Scenario: Connecting the bucket restores the fleet state
      When the operator runs "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "b"
      Then the command exits 0
      And the output contains "Restored the fleet state from the bucket."

    Scenario: The replacement holds the configuration the first manager stored
      Given the operator ran "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "b"
      When the operator runs "fleet-state --export" on manager "b"
      Then the output is the configuration in the fleet state of manager "a"

  @litestream @s3 @slow
  Rule: The replacement changes the fleet in the S3 bucket; the first manager notices and follows

    Background:
      Given a new bucket on the S3 service
      And managers "a" and "b" run the pinned Litestream
      And commands on manager "a" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |
      And commands on manager "b" are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | test-access-key-id     |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | test-secret-access-key |
      And the operator ran "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "a"
      And the operator ran "fleet-state --import examples/fleet.json" on manager "a"
      And the operator ran "fleet-state --init --bucket $S3_BUCKET --endpoint $S3 --region us-east-1 --prefix fleets/one" on manager "b"
      And "~/edited.json" on manager "b" holds what "fleet-state --export" prints there, with "worker-two" renamed "worker-renamed"

    Scenario: The replacement's change reaches the bucket
      When the operator runs "fleet-state --import ~/edited.json" on manager "b"
      Then the report includes:
        """
        { "standing": "in-sync" }
        """

    Scenario: The first manager is behind the bucket
      Given the operator ran "fleet-state --import ~/edited.json" on manager "b"
      When the operator runs "fleet-state" on manager "a"
      Then the report includes:
        """
        { "standing": "bucket-ahead" }
        """

    Scenario: The first manager restores the replacement's change
      Given the operator ran "fleet-state --import ~/edited.json" on manager "b"
      And the operator ran "fleet-state" on manager "a"
      When the operator runs "fleet-state --restore" on manager "a"
      Then the report includes:
        """
        { "standing": "in-sync" }
        """
      And the configuration in the fleet state of manager "a" contains "worker-renamed"
