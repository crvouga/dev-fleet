# ␉ stands for a tab and ␊ for a line break.
Feature: Workers declare the features they are built with
  A worker has containers (Docker) and a desktop session unless the fleet
  configuration says otherwise: fleet-wide under `worker.features`, or for
  one worker under its own `features`. Each block may name a preset first;
  `editing` is a worker for remote code editing by agents: no containers, a
  headless session and only the base tools. A fleet that names no feature
  gets exactly what every worker had before features existed. What a worker
  lacks is not installed, and the checks of it say they do not apply.

  Background:
    Given the example fleet configuration

  Rule: Features come from the defaults, the fleet, then the worker, each preset first

    Scenario: A fleet that names no feature keeps containers and a desktop session
      Given the fleet configuration leaves out "worker.features"
      When the fleet configuration is read
      Then the worker "worker-one" has containers on and a "desktop" session
      And the worker "worker-two" has containers on and a "desktop" session

    Scenario Outline: <case>
      Given the fleet configuration sets "worker.features" to <fleet-wide>
      And the fleet configuration sets the "features" of the worker "worker-two" to <own>
      When the fleet configuration is read
      Then the worker "worker-one" has containers <one> and a "<one session>" session
      And the worker "worker-two" has containers <two> and a "<two session>" session

      Examples:
        | case                                                     | fleet-wide              | own                      | one | one session | two | two session |
        | One worker uses the editing preset                       | {}                      | {"preset": "editing"}    | on  | desktop     | off | headless    |
        | The fleet uses the preset and one worker takes containers | {"preset": "editing"}   | {"containers": true}     | off | headless    | on  | headless    |
        | The fleet turns containers off                           | {"containers": false}   | {}                       | off | desktop     | off | desktop     |
        | A worker's own session wins over the fleet's             | {"session": "headless"} | {"session": "desktop"}   | on  | headless    | on  | desktop     |

  Rule: Only known features and values are accepted

    Scenario Outline: <case> is refused, naming the field
      Given the fleet configuration sets "worker.features" to <value>
      When the fleet configuration is read
      Then it is refused with "<code>" at "<path>"

      Examples:
        | case                 | value                   | code               | path                             |
        | An unknown preset    | {"preset": "gaming"}    | DEFINITION_INVALID | $.worker.features.preset         |
        | An unknown session   | {"session": "kiosk"}    | DEFINITION_INVALID | $.worker.features.session        |
        | Containers as a word | {"containers": "no"}    | DEFINITION_INVALID | $.worker.features.containers     |
        | An unknown feature   | {"gpu": true}           | DEFINITION_UNKNOWN | $.worker.features.gpu            |

    Scenario: A worker's own unknown session is refused at that worker
      Given the fleet configuration sets the "features" of the worker "worker-one" to {"session": "wayland"}
      When the fleet configuration is read
      Then it is refused with "DEFINITION_INVALID" at "$.workers[0].features.session"

  Rule: A worker without containers installs no Docker and is not checked for it

    Scenario: The base tools of a worker without containers leave out the Docker CLI
      Given the fleet configuration leaves out "worker.toolProfiles"
      And the fleet configuration sets the "features" of the worker "worker-two" to {"preset": "editing"}
      When the fleet configuration is read
      Then the worker "worker-two" installs the base tools without "docker-cli"
      And the worker "worker-one" installs the base tools, then these:
        | (none) |

    Scenario: The toolchain of a worker without containers needs no Docker engine
      Given the fleet configuration sets the "features" of the worker "worker-two" to {"containers": false}
      And the doctor of the checkout reports ok, with these checks:
        | id  | status | detail |
        | bun | pass   | 1.4.4  |
      When the toolchain of the worker "worker-two" in the checkout at "/repo" is checked
      Then the doctor was run with "--json --worker --profiles go --no-containers"
      And the check "tool:docker-cli" is not applicable
      And the summary of the check "tool:docker-cli" mentions "containers are off for this worker"

    Scenario: The Docker packages and service of a worker without containers do not apply
      Given every command fails
      When the host of a worker with the features {"containers": false} is checked
      Then the check "worker:package:docker.io" is not applicable
      And the check "worker:package:docker-compose-v2" is not applicable
      And the check "worker:package:docker-buildx" is not applicable
      And the check "worker:service:docker" is not applicable
      And the summary of the check "worker:service:docker" mentions "containers are off for this worker"
      And the check "worker:package:dconf-cli" fails
      And the check "worker:features" passes

    Scenario: The desktop packages of a headless worker do not apply
      Given every command fails
      When the host of a worker with the features {"containers": false, "session": "headless"} is checked
      Then the check "worker:package:dconf-cli" is not applicable
      And the summary of the check "worker:package:dconf-cli" mentions "headless session"

    Scenario: A Docker package left on a worker without containers fails, naming it
      Given every command fails
      And the command "dpkg-query -W" prints "docker.io␉ii ␊docker-buildx␉rc ␊"
      And the command "id -nG dev" prints "dev sudo docker␊"
      When the host of a worker with the features {"containers": false} is checked
      Then the check "worker:features" fails
      And the summary of the check "worker:features" mentions "WORKER_FEATURE_REMOVAL_INCOMPLETE"
      And the summary of the check "worker:features" mentions "package docker.io, membership of the docker group"

    Scenario: A sync that turns containers off reports what it removed
      Given before the sync a worker without containers held:
        | package docker.io         |
        | package docker-compose-v2 |
        | package docker-buildx     |
        | group docker              |
      When after the sync the worker without containers holds:
        | (none) |
      Then the check "worker:features" passes
      And the summary of the check "worker:features" mentions "this run removed package docker.io, package docker-compose-v2, package docker-buildx, membership of the docker group"

    Scenario: A worker with the default features is checked for Docker as before
      Given every command fails
      When the host of a worker with the features {} is checked
      Then the check "worker:package:docker.io" fails
      And the check "worker:service:docker" fails
      And the check "worker:features" passes
