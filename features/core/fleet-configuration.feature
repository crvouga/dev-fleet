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

  Rule: A configuration that breaks a rule is refused

    Scenario Outline: Refused: <rule>
      Given the fleet configuration sets "<field>" to <value>
      When the fleet configuration is read
      Then it is refused

      Examples: A singleton service runs on the manager and names no host
        | rule                                         | field                | value                                        |
        | the proxy cannot be pinned to a host         | services.proxy.owner | "worker-one"                                 |
        | the proxy is an HTTPS origin, without a path | services.proxy       | {"endpoint":"http://not-https.invalid/path"} |

      Examples: Endpoints, accounts and the source repository are the fleet's own, and a malformed one is not accepted
        | rule                                         | field               | value                                      |
        | the source repository is an HTTPS URL        | source              | {"repository":"git@github.com:owner/repo"} |
        | monitoring names its public URL and accounts | services.monitoring | {"hubPort":8443}                           |

      Examples: Exactly one manager, on macOS, kept awake
        | rule                              | field                     | value   |
        | the manager runs macOS            | manager.os                | "linux" |
        | the manager never sleeps on power | manager.neverSleepOnPower | false   |

      Examples: The previous owner/parent shape is rejected
        | rule                                   | field   | value |
        | the configuration is written version 3 | version | 2     |

    Scenario Outline: Refused: a configuration without its <block>
      Endpoints, accounts and the source repository are this fleet's own
      configuration: any well-formed value is accepted, a missing one is not.
      Given the fleet configuration leaves out "<block>"
      When the fleet configuration is read
      Then it is refused

      Examples:
        | block   |
        | source  |
        | manager |

    Scenario: Refused: a worker that does not run Linux
      Given the fleet configuration lists only the worker "worker-one"
      And the fleet configuration sets the "os" of the worker "worker-one" to "macOS"
      When the fleet configuration is read
      Then it is refused

    Scenario: Refused: a worker listed twice
      Given the fleet configuration lists the worker "worker-one" a second time
      When the fleet configuration is read
      Then it is refused

    Scenario: Refused: a worker that carries the manager's id
      Given the fleet configuration lists only the worker "worker-one"
      And the fleet configuration sets the "id" of the worker "worker-one" to "manager-mac"
      When the fleet configuration is read
      Then it is refused

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
