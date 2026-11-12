Feature: The disk guard stops a runaway writer before a worker's disk is full
  When free space falls below the floor, the service that wrote the most
  since the guard last looked is stopped, if it wrote enough to be a
  runaway. The guard reads what each service has written from its cgroup.

  Background:
    Given these services have written to disk since they started:
      | service                                         | written |
      | user-1000.slice/app.slice/t3code.service        | 10 MiB  |
      | user-1000.slice/app.slice/board-relay.service   | 900 MiB |
      | user-1000.slice/app.slice/t3code-claude-a.scope | 100 MiB |
    And "user-1000.slice" has totals of its own that are not a service's
    And a service that wrote 32 MiB since the guard last looked is a runaway

  Rule: Below the floor, only the top runaway writer is chosen

    Scenario: The first look has nothing to compare with and chooses nobody
      Given the disk is below its floor of free space
      When the guard looks for the first time
      Then no service is chosen

    Scenario: The service that wrote the most since the last look is chosen
      Given the disk is below its floor of free space
      And since the guard last looked, "board-relay.service" wrote 800 MiB and every other service 1 MiB
      When the guard looks
      Then "board-relay.service" is chosen, having written 800 MiB

  Rule: With free space, or with only slow writers, nothing is killed

    Scenario Outline: Nothing is chosen while <situation>
      Given the disk <space>
      And since the guard last looked, every service wrote <written> MiB
      When the guard looks
      Then no service is chosen

      Examples:
        | situation                  | space                            | written |
        | the disk has free space    | has free space                   | 800     |
        | every writer is a slow one | is below its floor of free space | 1       |

  Rule: A filesystem is below its floor when it is short of bytes or of inodes
    A worker that holds many dependency trees runs out of inodes long before
    bytes, and every write then fails.

    Scenario Outline: <free> MiB and <inodes>% of inodes free is <verdict>
      When the guard measures a filesystem with <free> MiB and <inodes>% of its inodes free, against floors of 3072 MiB and 2% of inodes
      Then the filesystem is <verdict>

      Examples:
        | free  | inodes | verdict          |
        | 50000 | 40     | above its floors |
        | 1000  | 40     | below its floors |
        | 50000 | 0      | below its floors |
        | 50000 | 1.5    | below its floors |
