Feature: fleet-state takes the bucket's credentials from the environment or a prompt, never from arguments
  Credentials are passed to a command in DEVFLEET_BUCKET_ACCESS_KEY_ID and
  DEVFLEET_BUCKET_SECRET_ACCESS_KEY, or typed at its prompt. `--init` saves
  them in bucket.json for the runs a manager starts by itself. No report or
  output ever repeats them.

  In a command or a path, `~` is the manager's home. "The example fleet" is
  examples/fleet.json without the bucket it names. A stand-in for Litestream
  keeps the bucket in a directory.

  Rule: Credentials come from the environment or a prompt and are stored privately, never echoed

    Scenario: At a terminal the operator is asked for both keys
      Given the operator at the terminal of the manager answers "secret/example+key" when asked for a secret and "AKIDEXAMPLE" otherwise
      When the operator runs "fleet-state --init --bucket fleet-state --endpoint https://s3.example.com --region auto" on the manager
      Then the operator was asked exactly:
        | Bucket access key ID (empty to use the AWS environment or profile) |
        | Bucket secret access key                                           |
      And nothing the command returned contains "secret/example+key"
      And the report includes:
        """
        {
          "bucket": {
            "kind": "s3",
            "bucket": "fleet-state",
            "prefix": "dev-fleet",
            "credentials": "bucket.json"
          }
        }
        """
      And the bucket.json of the manager includes:
        """
        { "secretAccessKey": "secret/example+key" }
        """

    Scenario: With no terminal and no credentials passed, the standard AWS environment is used
      When the operator runs "fleet-state --init --bucket fleet-state" on the manager
      Then the report includes:
        """
        { "bucket": { "location": "bucket.json", "credentials": "aws" } }
        """

    Scenario: An access key passed without its secret is refused
      Given the operator ran "fleet-state --init --bucket fleet-state" on the manager
      And commands on the manager are passed:
        | DEVFLEET_BUCKET_ACCESS_KEY_ID | AKID |
      When the operator runs "fleet-state --init --bucket fleet-state" on the manager
      Then it is refused with "never taken from arguments"

  Rule: A project that names its bucket needs only credentials passed to each command

    Background:
      Given "~/project/fleet.json" on the manager holds the example fleet with the bucket:
        """
        { "bucket": "fleet-state", "endpoint": "https://s3.example.com" }
        """
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/project/fleet.json |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED           |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed+key    |

    Scenario: A command reaches the project's bucket with the passed keys and saves nothing
      When the operator runs "fleet-state --push" on the manager
      Then the report includes:
        """
        {
          "standing": "empty",
          "bucket": {
            "bucket": "fleet-state",
            "location": "fleet.json",
            "credentials": "environment"
          }
        }
        """
      And the report includes these checks:
        | state:bucket     | pass |
        | state:definition | pass |
      And the last Litestream command had in its environment:
        | AWS_ACCESS_KEY_ID     | AKIDPASSED        |
        | AWS_SECRET_ACCESS_KEY | secret/passed+key |
      And the manager has no bucket.json
      And nothing the command returned contains "secret/passed"

    Scenario: The bucket is the project's to name: a flag cannot point elsewhere
      Given the operator ran "fleet-state --push" on the manager
      When the operator runs "fleet-state --init --bucket another-fleet" on the manager
      Then it is refused with "names another bucket"

  Rule: --init saves the project's bucket and the passed credentials for runs this machine starts by itself

    Background:
      Given "~/project/fleet.json" on the manager holds the example fleet with the bucket:
        """
        { "bucket": "fleet-state" }
        """
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/project/fleet.json |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDPASSED           |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/passed+key    |

    Scenario: The bucket and the keys are saved in bucket.json
      When the operator runs "fleet-state --init" on the manager
      Then the command exits 0
      And the bucket.json of the manager includes:
        """
        {
          "bucket": "fleet-state",
          "accessKeyId": "AKIDPASSED",
          "secretAccessKey": "secret/passed+key"
        }
        """

    Scenario: A later command that is passed nothing uses them
      The schedule, or a hand-off from a worker.
      Given the operator ran "fleet-state --init" on the manager
      And commands on the manager are passed:
        | DEVFLEET_CONFIG | ~/project/fleet.json |
      When the operator runs "fleet-state" on the manager
      Then the report includes:
        """
        { "bucket": { "location": "fleet.json", "credentials": "bucket.json" } }
        """

    Scenario: Repeating --init without credentials keeps the saved ones
      Given the operator ran "fleet-state --init" on the manager
      And commands on the manager are passed:
        | DEVFLEET_CONFIG | ~/project/fleet.json |
      And the operator ran "fleet-state" on the manager
      When the operator runs "fleet-state --init" on the manager
      Then the bucket.json of the manager includes:
        """
        { "accessKeyId": "AKIDPASSED" }
        """

    Scenario: Repeating --init with new credentials rotates them
      Given the operator ran "fleet-state --init" on the manager
      And commands on the manager are passed:
        | DEVFLEET_CONFIG | ~/project/fleet.json |
      And the operator ran "fleet-state --init" on the manager
      And commands on the manager are passed:
        | DEVFLEET_CONFIG                   | ~/project/fleet.json |
        | DEVFLEET_BUCKET_ACCESS_KEY_ID     | AKIDROTATED          |
        | DEVFLEET_BUCKET_SECRET_ACCESS_KEY | secret/rotated       |
      When the operator runs "fleet-state --init" on the manager
      Then the bucket.json of the manager includes:
        """
        { "accessKeyId": "AKIDROTATED" }
        """
