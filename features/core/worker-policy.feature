Feature: What every worker must have
  The fleet configuration says what every worker is required to have. The
  roster the manager keeps for itself may ask more of one worker; it can never
  ask less, and a policy that leaves a requirement out is refused.

  Background:
    Given the example fleet configuration
    And it requires every worker to have:
      | github      |
      | vault       |
      | t3          |
      | toolchain   |
      | workstation |
      | worker      |

  Scenario: A roster entry that requires nothing still carries every requirement
    The roster holds the manager's private connection details; what a worker
    must have is not one of them.
    Given a roster of these workers:
      | id         | ssh        | workspace           | required |
      | worker-one | worker-one | /home/dev/workspace | nothing  |
    When the manager enrolls the workers of the roster
    Then the worker "worker-one" is required to have:
      | github      |
      | vault       |
      | t3          |
      | toolchain   |
      | workstation |
      | worker      |

  Scenario Outline: A worker policy that does not require "<capability>" is refused
    When the worker policy is read without "<capability>" among its required capabilities
    Then it is refused

    Examples:
      | capability  |
      | github      |
      | vault       |
      | t3          |
      | toolchain   |
      | workstation |
      | worker      |
