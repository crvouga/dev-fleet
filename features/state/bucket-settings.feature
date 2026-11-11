Feature: Where the fleet state is kept is a few validated settings
  The bucket is an S3-compatible bucket or a directory. Its settings are
  checked before anything is sent anywhere, saved for their owner only, and
  never printed or passed as an argument with a credential.

  Rule: An S3 bucket and a directory are both accepted, with a default prefix

    Scenario: An S3 bucket with its keys
      Given these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |
      When the settings are read
      Then the bucket is exactly:
        | kind            | s3                     |
        | prefix          | dev-fleet              |
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |

    Scenario: A bucket name alone
      Given the bucket settings are {"bucket": "fleet-state"}
      When the settings are read
      Then the bucket is exactly:
        | kind   | s3          |
        | bucket | fleet-state |
        | prefix | dev-fleet   |

    Scenario: A directory
      Given the bucket settings are {"directory": "/Volumes/backup/fleet"}
      When the settings are read
      Then the bucket is exactly:
        | kind | directory             |
        | path | /Volumes/backup/fleet |

  Rule: Settings that would leak or misroute the state are refused

    Scenario Outline: Refused: <why>
      Given the bucket settings are <settings>
      When the settings are read
      Then it is refused with "Invalid bucket settings"

      Examples:
        | why                                 | settings                                                              |
        | no settings at all                  | null                                                                  |
        | a version this release cannot read  | {"version": 2, "bucket": "fleet-state"}                               |
        | a name no S3 bucket can have        | {"bucket": "Fleet_State"}                                             |
        | an endpoint over plain HTTP         | {"bucket": "fleet-state", "endpoint": "http://s3.example.com"}        |
        | an endpoint with a path             | {"bucket": "fleet-state", "endpoint": "https://s3.example.com/path"}  |
        | a prefix that leaves the bucket     | {"bucket": "fleet-state", "prefix": "../other"}                       |
        | a prefix that ends in a slash       | {"bucket": "fleet-state", "prefix": "trailing/"}                      |
        | an access key without its secret    | {"bucket": "fleet-state", "accessKeyId": "only-half"}                 |
        | a setting nobody knows              | {"bucket": "fleet-state", "token": "unknown"}                         |
        | a directory that is not absolute    | {"directory": "relative/path"}                                        |
        | a directory and a bucket at once    | {"directory": "/a", "bucket": "fleet-state"}                          |

    Scenario: A local S3 service for trying it out is the one plain-HTTP exception
      Given the bucket settings are {"bucket": "fleet-state", "endpoint": "http://127.0.0.1:9000"}
      When the settings are read
      Then the bucket includes:
        | endpoint | http://127.0.0.1:9000 |

  Rule: bucket.json is written privately and one others can read is not used

    Background:
      Given these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |

    Scenario: A manager nothing was saved on has no saved bucket
      Given a manager without a fleet state
      Then the manager has no saved bucket

    Scenario: The settings are saved for their owner only
      When the settings are saved on the manager
      Then the bucket.json of the manager is readable by its owner only
      And the saved bucket of the manager is exactly:
        | kind            | s3                     |
        | prefix          | dev-fleet              |
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |
      And the bucket.json of the manager includes:
        """
        { "version": 1 }
        """

    Scenario: A bucket.json others can read is not used
      Given the settings were saved on the manager
      And the bucket.json of the manager was made readable by others
      When the saved bucket of the manager is read
      Then it is refused with "must be private"

    Scenario: A bucket.json that is not JSON is refused
      Given the settings were saved on the manager
      And the bucket.json of the manager was overwritten with "not json"
      When the saved bucket of the manager is read
      Then it is refused with "Invalid bucket settings"

  Rule: Nothing printed or passed as an argument carries a credential

    Scenario Outline: <what> names neither key
      Given these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |
      When the settings are read
      Then <what> contains neither "AKIDEXAMPLE" nor "secret/example+key"

      Examples:
        | what                                             |
        | the description of the bucket                    |
        | the Litestream configuration of "/state/fleet.db" |
        | the identity of the bucket                       |

    Scenario: The keys reach Litestream through its environment
      Given these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |
      When the settings are read
      Then Litestream is handed exactly this environment:
        | AWS_ACCESS_KEY_ID     | AKIDEXAMPLE        |
        | AWS_SECRET_ACCESS_KEY | secret/example+key |
        | AWS_SESSION_TOKEN     |                    |

    Scenario: Without keys the standard AWS environment is left alone
      Given the bucket settings are {"bucket": "fleet-state"}
      When the settings are read
      Then Litestream is handed no environment of its own

    Scenario: No bucket is described as not configured
      Then a manager with no bucket is described as:
        """
        { "configured": false }
        """

  Rule: The Litestream configuration names the replica and nothing else

    Scenario: An S3 bucket is an "s3" replica under the prefix
      Given these bucket settings:
        | bucket          | fleet-state            |
        | endpoint        | https://s3.example.com |
        | region          | auto                   |
        | accessKeyId     | AKIDEXAMPLE            |
        | secretAccessKey | secret/example+key     |
      When the settings are read
      Then the Litestream configuration of "/state/fleet.db" contains each of:
        | type: s3                         |
        | bucket: fleet-state              |
        | path: dev-fleet/fleet.db         |
        | endpoint: https://s3.example.com |
        | force-path-style: true           |

    Scenario: A directory is a "file" replica
      Given the bucket settings are {"directory": "/Volumes/backup/fleet"}
      When the settings are read
      Then the Litestream configuration of "/state/fleet.db" contains each of:
        | type: file                           |
        | path: /Volumes/backup/fleet/fleet.db |
