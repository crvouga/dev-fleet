Feature: A worker's disk and memory lines scale with the machine
  Every line of the worker policy is a share of the root filesystem or of
  memory, between a lower and an upper bound, declared once under `sizing`
  in the Ubuntu policy: the swap file, the free disk the baseline keeps, the
  disk guard's floor, the line under which the disk GC works under pressure,
  and the lines under which worker:capacity warns and fails. A small rented
  instance gets lines it can meet; large disks retain enough free space for builds before warning or cleanup.

  Rule: The lines are shares between bounds

    Scenario: A small rented instance gets lines it can meet
      Then on a machine with 8 GiB of memory and a 40 GiB disk the lines are, in MiB:
        | line            | MiB  |
        | swapFile        | 4096 |
        | minimumFreeDisk | 2048 |
        | diskGuardFloor  | 1228 |
        | diskGcPressure  | 8192 |
        | capacityWarn    | 6144 |
        | capacityFail    | 1024 |

    Scenario: A large workstation reserves space before builds fill its disk
      Then on a machine with 64 GiB of memory and a 500 GiB disk the lines are, in MiB:
        | line            | MiB   |
        | swapFile        | 8192  |
        | minimumFreeDisk | 4096  |
        | diskGuardFloor  | 3072  |
        | diskGcPressure  | 102400 |
        | capacityWarn    | 76800 |
        | capacityFail    | 2048  |

    Scenario: A nearly one terabyte disk warns before it is full
      Then on a machine with 64 GiB of memory and a 937 GiB disk the lines are, in MiB:
        | line           | MiB    |
        | diskGcPressure | 191897 |
        | capacityWarn   | 143923 |

    Scenario Outline: No line leaves its bounds on a <disk> GiB disk
      Then no line is above its declared upper bound on a <disk> GiB disk

      Examples:
        | disk |
        | 20   |
        | 500  |
        | 4000 |

  Rule: worker:capacity warns and fails at the lines of its own disk

    Scenario Outline: <free> MiB free on a <disk> GiB disk <verdict>
      When a disk of <disk> GiB has <free> MiB free
      Then the check "worker:capacity:disk" <verdict>

      Examples:
        | disk | free  | verdict |
        | 40   | 7000  | passes  |
        | 40   | 3500  | warns   |
        | 40   | 900   | fails   |
        | 500  | 9000  | warns   |
        | 500  | 80000 | passes  |

  Rule: fleet-status says how many agent sessions the memory policy supports, and how many run

    The memory user workloads may use (90%), less what T3 keeps for itself
    (1536 MiB), in sessions of an estimated 1024 MiB each. The size of a
    session is an estimate, so running more only warns.

    Scenario Outline: A worker with <memory> MiB running <running> sessions <verdict>
      When a worker with <memory> MiB of memory runs <running> agent sessions
      Then the check "worker:agent-sessions" <verdict>
      And the summary of the check "worker:agent-sessions" mentions "<summary>"

      Examples:
        | memory | running | verdict | summary                                                                                                |
        | 8192   | 2       | passes  | 2 agent sessions running; the memory policy supports 5 at once on 8192 MiB (an estimated 1024 MiB each). |
        | 16384  | 3       | passes  | the memory policy supports 12 at once                                                                  |
        | 8192   | 6       | warns   | AGENT_SESSION_CAPACITY_EXHAUSTED: 6 agent sessions running                                             |

    Scenario: The capacity probe of a worker reports its sessions
      Given every command prints:
        """
        ncpu=2
        load=0.2
        memfree=60
        memtotalmb=8192
        agentsessions=1
        swap=0
        diskmb=30000
        disktotalmb=40960
        """
      When the capacity of the worker is checked
      Then the check "worker:agent-sessions" passes
      And the summary of the check "worker:agent-sessions" mentions "1 agent sessions running; the memory policy supports 5 at once"
      And the check "worker:capacity:disk" passes
