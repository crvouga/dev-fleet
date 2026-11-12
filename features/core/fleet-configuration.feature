Feature: The fleet configuration
  A fleet is described once, in its fleet.json: one macOS manager, the Linux
  workers, and the services the manager hosts for them. A configuration that
  breaks a rule is refused as a whole; nothing in it is guessed or repaired.

  Background:
    Given the example fleet configuration

  Rule: A fleet is one macOS manager and Linux workers

    Scenario: The example is a manager, its workers and the services they share
      When the fleet configuration is read
      Then the manager is "manager-mac", runs "macOS" and never sleeps on power
      And there is at least one worker
      And every worker runs "linux"
      And the proxy is served at "https://cli-proxy.example.com"
      And the monitoring hub is reached at "https://manager-mac-1.tail0a1b2c.ts.net:8443"

    Scenario Outline: "<machine>" is <role>
      When the fleet configuration is read
      Then "<machine>" is <role>

      Examples:
        | machine     | role                    |
        | manager-mac | the manager             |
        | worker-one  | a worker                |
        | unknown     | no machine of the fleet |

    Scenario Outline: A Mac that calls itself "<host name>" is the machine "<id>"
      The manager recognises itself by its host name, whatever its case and
      with or without the ".local" macOS adds.
      Then the host name "<host name>" is the fleet id "<id>"

      Examples:
        | host name         | id          |
        | Manager-Mac       | manager-mac |
        | Manager-Mac.local | manager-mac |

  Rule: A configuration that breaks a rule is refused, naming where
    The refusal names the first field that breaks a rule as a JSONPath, what
    was expected there and what was found, so nobody has to bisect the file.

    Scenario Outline: Refused at <path>: <rule>
      Given the fleet configuration sets "<field>" to <value>
      When the fleet configuration is read
      Then it is refused with "<code>" at "<path>"

      Examples: A singleton service runs on the manager and names no host
        | rule                                         | field                | value                                        | code               | path                      |
        | the proxy cannot be pinned to a host         | services.proxy.owner | "worker-one"                                 | DEFINITION_UNKNOWN | $.services.proxy.owner    |
        | the proxy is an HTTPS origin, without a path | services.proxy       | {"endpoint":"http://not-https.invalid/path"} | DEFINITION_INVALID | $.services.proxy.endpoint |

      Examples: Endpoints, accounts and the source repository are the fleet's own, and a malformed one is not accepted
        | rule                                         | field                             | value                                      | code               | path                                |
        | the source repository is an HTTPS URL        | source                            | {"repository":"git@github.com:owner/repo"} | DEFINITION_INVALID | $.source.repository                 |
        | monitoring names its public URL and accounts | services.monitoring               | {"hubPort":8443}                           | DEFINITION_MISSING | $.services.monitoring.publicUrl     |
        | an account is an email address               | services.monitoring.viewerAccount | "nobody"                                   | DEFINITION_INVALID | $.services.monitoring.viewerAccount |

      Examples: Exactly one manager, on macOS, kept awake
        | rule                              | field                     | value   | code               | path                        |
        | the manager runs macOS            | manager.os                | "linux" | DEFINITION_INVALID | $.manager.os                |
        | the manager never sleeps on power | manager.neverSleepOnPower | false   | DEFINITION_INVALID | $.manager.neverSleepOnPower |

      Examples: Workers and the worker policy name the field
        | rule                               | field                     | value         | code               | path                         |
        | a port is from 1 to 65535          | workers.1.network.sshPort | 70000         | DEFINITION_INVALID | $.workers[1].network.sshPort |
        | a worker has no setting of its own | workers.0.colour          | "red"         | DEFINITION_UNKNOWN | $.workers[0].colour          |
        | the canary is a declared worker    | canary                    | "worker-nine" | DEFINITION_INVALID | $.canary                     |
        | the GitHub login is a login        | worker.githubLogin        | "has space"   | DEFINITION_INVALID | $.worker.githubLogin         |

      Examples: Workers run a release of the support matrix, and fleet-watch a known target
        | rule                                        | field          | value                 | code               | path             |
        | the release is one the support matrix lists | ubuntu.release | "24.04"               | DEFINITION_INVALID | $.ubuntu.release |
        | a notify target is webhook or ntfy          | notify         | {"targets":["pager"]} | DEFINITION_INVALID | $.notify         |

      Examples: The previous owner/parent shape is rejected
        | rule                                   | field   | value | code               | path      |
        | the configuration is written version 3 | version | 2     | DEFINITION_INVALID | $.version |

    Scenario Outline: Refused: a configuration without its <block>
      Endpoints, accounts and the source repository are this fleet's own
      configuration: any well-formed value is accepted, a missing one is not.
      Given the fleet configuration leaves out "<block>"
      When the fleet configuration is read
      Then it is refused with "DEFINITION_MISSING" at "$.<block>"

      Examples:
        | block   |
        | source  |
        | manager |

    Scenario: Refused: a worker that does not run Linux
      Given the fleet configuration lists only the worker "worker-one"
      And the fleet configuration sets the "os" of the worker "worker-one" to "macOS"
      When the fleet configuration is read
      Then it is refused with "DEFINITION_INVALID" at "$.workers[0].os"

    Scenario: Refused: a worker listed twice
      Given the fleet configuration lists the worker "worker-one" a second time
      When the fleet configuration is read
      Then it is refused with "DEFINITION_DUPLICATE" at "$.workers[2].id"

    Scenario: Refused: a worker that carries the manager's id
      Given the fleet configuration lists only the worker "worker-one"
      And the fleet configuration sets the "id" of the worker "worker-one" to "manager-mac"
      When the fleet configuration is read
      Then it is refused with "DEFINITION_DUPLICATE" at "$.workers[0].id"

  Rule: The JSON schema and the parser agree
    An editor checks fleet.json with schema/fleet.schema.json and devfleet
    reads it with its parser. Every definition in this corpus is accepted by
    both or refused by both, so the two cannot drift apart unnoticed.

    Scenario Outline: The schema and the parser both <verdict> a definition where <change>
      Given the fleet configuration sets "<field>" to <value>
      When the fleet configuration is judged by the schema and by the parser
      Then both <verdict> it

      Examples: Accepted
        | change                            | verdict | field   | value                                            |
        | nothing is changed                | accept  | version | 3                                                |
        | a canary is named                 | accept  | canary  | "worker-two"                                     |
        | there are no workers              | accept  | workers | []                                               |
        | the bucket is a directory         | accept  | state   | {"directory":"/mnt/fleet"}                       |
        | another fleet's source is named   | accept  | source  | {"repository":"https://git.example.org/a/b.git"} |
        | secrets come from the environment | accept  | secrets | {"provider":"env"}                               |
        | workers are parked and judged idle | accept | parking | {"idleAfterHours":12,"stop":["infra/stop"],"start":["infra/start"]} |
        | a worker declares what it costs   | accept  | workers.0.billing | {"hourlyRate":0.5,"currency":"USD","note":"rented"} |
        | a worker's host key is given      | accept  | workers.0.network.hostKey | "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfTheWorker" |
        | a worker carries labels           | accept  | workers.0.labels | {"pool":"rented"} |

      Examples: Refused
        | change                           | verdict | field                       | value                                                          |
        | the version is 2                 | refuse  | version                     | 2                                                              |
        | the manager runs Linux           | refuse  | manager.os                  | "linux"                                                        |
        | the manager may sleep            | refuse  | manager.neverSleepOnPower   | false                                                          |
        | a worker port is out of range    | refuse  | workers.1.network.sshPort   | 70000                                                          |
        | a worker runs macOS              | refuse  | workers.0.os                | "macOS"                                                        |
        | a worker has an unknown setting  | refuse  | workers.0.colour            | "red"                                                          |
        | a worker id is upper case        | refuse  | workers.0.id                | "Worker"                                                       |
        | the proxy is plain HTTP          | refuse  | services.proxy.endpoint     | "http://proxy.example"                                         |
        | the hub port is another          | refuse  | services.monitoring.hubPort | 8080                                                           |
        | the release is not a version     | refuse  | ubuntu.release              | "latest"                                                       |
        | a capability is unknown          | refuse  | worker.requiredCapabilities | ["github","vault","t3","toolchain","workstation","worker","x"] |
        | the toolchain is another         | refuse  | worker.toolchain            | "none"                                                         |
        | the source is not HTTPS          | refuse  | source.repository           | "git@example.org:a/b.git"                                      |
        | secrets name an unknown provider | refuse  | secrets                     | {"provider":"keychain"}                                        |
        | the bucket holds credentials     | refuse  | state                       | {"bucket":"my-fleet-state","accessKeyId":"x"}                  |
        | there is an unknown block        | refuse  | extra                       | {}                                                             |
        | a canary id is malformed         | refuse  | canary                      | "Not An Id"                                                    |
        | a host key is not a key          | refuse  | workers.0.network.hostKey   | "not a key"                                                    |
        | an hourly rate is negative       | refuse  | workers.0.billing           | {"hourlyRate":-1}                                              |
        | a worker is idle after no time   | refuse  | parking                     | {"idleAfterHours":0}                                           |
        | parking has an unknown setting   | refuse  | parking                     | {"sleep":true}                                                 |

    Scenario Outline: Only the parser refuses a definition where <change>
      A rule that relates two fields cannot be written in the schema. These
      are the only ones.
      Given the fleet configuration sets "<field>" to <value>
      When the fleet configuration is judged by the schema and by the parser
      Then the schema accepts it and the parser refuses it

      Examples:
        | change                              | field        | value         |
        | two workers share an id             | workers.1.id | "worker-one"  |
        | a worker carries the manager's id   | workers.0.id | "manager-mac" |
        | the canary is not a declared worker | canary       | "worker-nine" |
        | workers are parked by themselves, never judged idle | parking | {"autoPark":true} |

    Scenario: The example worker records conform to their published schema, and the parser reads them
      When the worker records in "examples/workers-from-infrastructure/worker-records.json" are judged by "schema/worker-record.schema.json" and by the parser
      Then both accept it

    Scenario: The schema and the parser both accept a worker reached from its network block alone
      Given the fleet configuration leaves out "workers.0.ssh"
      When the fleet configuration is judged by the schema and by the parser
      Then both accept it

  Rule: Every fleet declares its own endpoints, accounts and source repository

    Scenario: Another fleet's endpoints, accounts and repository are taken as written
      Given the fleet configuration sets "source" to {"repository":"https://git.example.org/team/machines.git"}
      And the fleet configuration sets "services" to:
        """
        {
          "proxy": { "endpoint": "https://proxy.example.org" },
          "monitoring": {
            "hubPort": 8443,
            "publicUrl": "https://status.example.org",
            "managerAccount": "fleet@example.org",
            "viewerAccount": "viewer@example.org"
          }
        }
        """
      When the fleet configuration is read
      Then the proxy is served at "https://proxy.example.org"
      And machines take dev-fleet from "https://git.example.org/team/machines.git"
