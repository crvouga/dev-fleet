Feature: The roster of enrolled workers is kept in the fleet state
  A roster file is only used when one is named. Otherwise the roster is the
  `roster` document of the fleet state, written as "state:roster".

  Rule: The roster is kept in the fleet state unless a file is named

    Scenario: No roster is named
      Given a workspace
      When a command resolves its settings in the workspace
      Then its roster is "state:roster"

    Scenario: The fleet state is named
      Given a workspace
      When a command resolves its settings in the workspace with the roster "state:roster"
      Then its roster is "state:roster"

    Scenario: A file is named
      Given a workspace
      When a command resolves its settings in the workspace with the roster file "roster.json"
      Then its roster is the file "roster.json" in the workspace

    Scenario: The workspace holds a .fleet.local.json
      Given a workspace
      And the workspace holds ".fleet.local.json":
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """
      When a command resolves its settings in the workspace
      Then its roster is the file ".fleet.local.json" in the workspace

  Rule: fleet-node-add writes the roster in the fleet state and reports how it stands with the bucket

    Background:
      Given the process runs on a manager with an empty fleet state

    Scenario: A manager with no roster reads none
      When the roster "state:roster" is read
      Then there is no roster

    Scenario: A roster that fleet-sync needs and is not there is refused
      When the roster "state:roster" is loaded for a fleet-sync
      Then it is refused with "Cannot read fleet config"

    Scenario: A preview shows the roster and writes nothing
      When this worker is previewed in the roster "state:roster":
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      Then the roster it shows lists 1 worker
      And there is still no roster "state:roster"

    Scenario: A worker is added and the roster reaches the bucket
      Given the manager replicates to the bucket
      When this worker is added to the roster "state:roster":
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      Then it reports "in-sync"
      And the roster "state:roster" lists these workers:
        | dev-one |

    Scenario: A worker is not added twice
      Given the manager replicates to the bucket
      And this worker was added to the roster "state:roster":
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      When this worker is added to the roster "state:roster":
        | id      | ssh     | workspace           |
        | dev-one | dev-one | /home/dev/workspace |
      Then it is refused with "unique"
