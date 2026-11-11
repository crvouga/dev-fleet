Feature: A command reaches the bucket its configuration names, with the credentials it is passed
  The fleet configuration says where the bucket is and never holds its
  credentials. Those are passed to every command in
  DEVFLEET_BUCKET_ACCESS_KEY_ID and DEVFLEET_BUCKET_SECRET_ACCESS_KEY. A
  manager that runs unattended gets no environment, so it uses what
  `fleet-state --init` saved on it.

  "The example fleet" is examples/fleet.json without the bucket it names, and
  "the example fleet.json" is that file as it is. In a path, `~` is the
  manager's home.

  Rule: The configuration names the bucket and the command is passed its credentials

    Background:
      Given the fleet configuration names the bucket:
        | bucket   | fleet-state            |
        | endpoint | https://s3.example.com |
        | region   | auto                   |

    Scenario: A project and two variables are enough
      Nothing is saved on this machine.
      Given commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When the connection is resolved
      Then the connection is exactly:
        """
        {
          "bucket": {
            "kind": "s3",
            "bucket": "fleet-state",
            "endpoint": "https://s3.example.com",
            "region": "auto",
            "prefix": "dev-fleet",
            "accessKeyId": "AKIDPASSED",
            "secretAccessKey": "secret/passed"
          },
          "location": "configuration",
          "credentials": "environment"
        }
        """

    Scenario: Passed credentials win over saved ones
      That is how they are rotated.
      Given the manager saved these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDSAVED              |
        | secretAccessKey | secret/saved           |
      And commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When the connection is resolved
      Then the credentials of the connection are "environment"

    Scenario: Without any credentials the standard AWS environment or profile is left to answer
      When the connection is resolved
      Then the credentials of the connection are "ambient"
      And the bucket of the connection has no "accessKeyId"

    Scenario: One variable without the other is refused
      Given commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID | AKIDPASSED |
      When the connection is resolved
      Then it is refused with "Set both"

  Rule: A manager that runs unattended uses what fleet-state --init saved on it

    Background:
      Given the manager saved these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDSAVED              |
        | secretAccessKey | secret/saved           |

    Scenario: Saved credentials are used for the bucket the configuration names
      Given the fleet configuration names the bucket:
        | bucket   | fleet-state            |
        | endpoint | https://s3.example.com |
        | region   | auto                   |
      When the connection is resolved
      Then the connection includes:
        """
        {
          "bucket": { "accessKeyId": "AKIDSAVED" },
          "location": "configuration",
          "credentials": "saved"
        }
        """

    Scenario: Without a configuration that names a bucket, the saved one is the bucket
      When the connection is resolved
      Then the connection includes:
        """
        {
          "bucket": { "bucket": "fleet-state", "accessKeyId": "AKIDSAVED" },
          "location": "saved",
          "credentials": "saved"
        }
        """

    Scenario: Keys saved for one bucket are never sent to another
      Given the fleet configuration names the bucket:
        | bucket   | another-fleet          |
        | endpoint | https://s3.example.com |
        | region   | auto                   |
      When the connection is resolved
      Then the credentials of the connection are "ambient"
      And the connection does not contain "AKIDSAVED"

    Scenario: A directory takes no credentials
      Given the fleet configuration names the bucket:
        | directory | /Volumes/backup/fleet |
      And commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When the connection is resolved
      Then the connection is exactly:
        """
        {
          "bucket": { "kind": "directory", "path": "/Volumes/backup/fleet" },
          "location": "configuration",
          "credentials": null
        }
        """

  Rule: Credentials alone reach no bucket

    Scenario: With no bucket named or saved there is no connection
      Given commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When the connection is resolved
      Then the connection is exactly:
        """
        { "bucket": null, "location": null, "credentials": null }
        """

  Rule: The bucket is read from the fleet.json the command runs with

    Scenario: The bucket the fleet.json names is the one reached
      Given "~/fleet.json" on the manager holds the example fleet with the bucket:
        """
        {
          "bucket": "fleet-state",
          "endpoint": "https://s3.example.com",
          "region": "auto"
        }
        """
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/fleet.json  |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When a command on the manager resolves its connection
      Then the connection includes:
        """
        {
          "bucket": { "bucket": "fleet-state", "accessKeyId": "AKIDPASSED" },
          "location": "configuration",
          "credentials": "environment"
        }
        """

    Scenario: A fleet.json that names no bucket reaches none
      Given "~/fleet.json" on the manager holds the example fleet
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/fleet.json  |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When a command on the manager resolves its connection
      Then the connection has no bucket

    Scenario: A fleet.json that names no bucket leaves the manager's saved bucket
      Given "~/fleet.json" on the manager holds the example fleet
      And the manager saved these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDSAVED              |
        | secretAccessKey | secret/saved           |
      And commands on the manager are passed:
        | DEVFLEET_CONFIG | ~/fleet.json |
      When a command on the manager resolves its connection
      Then the connection includes:
        """
        { "location": "saved", "credentials": "saved" }
        """

    Scenario: No configuration at all is not an error
      The first command on a new machine may be the one that restores it.
      Given the manager saved these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDSAVED              |
        | secretAccessKey | secret/saved           |
      And commands on the manager are passed:
        | DEVFLEET_CONFIG | ~/absent.json |
      When a command on the manager resolves its connection
      Then the location of the connection is "saved"

    Scenario: A broken fleet.json is an error
      It must not silently run without its bucket.
      Given "~/fleet.json" on the manager holds:
        """
        {
        """
      And the manager saved these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDSAVED              |
        | secretAccessKey | secret/saved           |
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/fleet.json  |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED    |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed |
      When a command on the manager resolves its connection
      Then it is refused with "not readable JSON"

  Rule: A configuration names a bucket and can never hold its credentials

    Scenario: The example fleet.json names a bucket
      When the example fleet.json is read
      Then it names the bucket {"bucket": "my-fleet-state", "endpoint": "https://s3.example.com", "region": "auto", "prefix": "dev-fleet"}

    Scenario: A directory can be named instead
      When the example fleet.json is read with the bucket {"directory": "/mnt/fleet"}
      Then it names the bucket {"directory": "/mnt/fleet"}

    Scenario Outline: Refused: <why>
      When the example fleet.json is read with the bucket <bucket>
      Then it is refused with "<message>"

      Examples:
        | why                                | bucket                                                                                                                           | message                       |
        | both keys beside the bucket        | {"bucket": "fleet-state", "endpoint": "https://s3.example.com", "region": "auto", "accessKeyId": "AKID", "secretAccessKey": "secret"} | Invalid bucket settings       |
        | a secret beside the bucket         | {"bucket": "fleet-state", "endpoint": "https://s3.example.com", "region": "auto", "secretAccessKey": "secret"}                   | Invalid bucket settings       |
        | the version bucket.json carries    | {"bucket": "fleet-state", "endpoint": "https://s3.example.com", "region": "auto", "version": 1}                                  | Invalid bucket settings       |
        | an endpoint without a bucket       | {"endpoint": "https://s3.example.com"}                                                                                           | Invalid bucket settings       |
        | a bucket and a directory at once   | {"bucket": "fleet-state", "directory": "/mnt/fleet"}                                                                             | Invalid bucket settings       |
        | a name instead of settings         | "fleet-state"                                                                                                                    | Invalid bucket settings       |
        | an access key, naming where it goes | {"bucket": "fleet-state", "endpoint": "https://s3.example.com", "region": "auto", "accessKeyId": "AKID"}                        | DEVFLEET_BUCKET_ACCESS_KEY_ID |

    Scenario: The schema editors validate against accepts the same block
      Then the schema of fleet.json accepts a bucket written with exactly these settings:
        | bucket, endpoint, region, prefix |
        | directory                        |

  Rule: Machines are sent the configuration without the bucket

    Scenario: The installed copy leaves out where the state is kept
      A launcher from a revision that predates the block still accepts it, and
      no worker learns where the state is kept.
      When the example fleet.json is prepared for installing on machines
      Then the installed copy has no "state"
      And the installed copy is otherwise the configuration that was read
      And the installed copy is read back with the same workers
