# ␊ stands for a line break and ␀ for a NUL byte.
Feature: The roster of workers the manager reaches
  The roster says how the manager reaches each worker: an SSH name and the
  path of its checkout. It is data only: nothing in it can become an SSH
  option, a second command or a path the manager did not write.

  Rule: A worker requires what its entry says, or the default

    Scenario: A worker that names no requirements gets the default ones
      Given a roster of these workers:
        | id   | ssh  | workspace |
        | test | host | /repo     |
      When the roster is read
      Then the worker "test" is required to have:
        | github    |
        | vault     |
        | t3        |
        | toolchain |

    Scenario: A worker may require nothing
      Given a roster of these workers:
        | id      | ssh     | workspace           | required |
        | dev-one | dev-one | /home/dev/workspace | nothing  |
      When the roster is read
      Then the worker "dev-one" is required to have nothing

  Rule: A roster is 1 to 64 workers, each a plain SSH name and an absolute path, and nothing else

    Background:
      Given a roster of these workers:
        | id      | ssh     | workspace           | required |
        | dev-one | dev-one | /home/dev/workspace | nothing  |

    Scenario Outline: An SSH name that is <what> is refused
      Given the worker "dev-one" has the field "ssh" set to "<ssh>"
      When the roster is read
      Then it is refused

      Examples:
        | what                         | ssh                 |
        | an SSH option                | -oProxyCommand=evil |
        | a user at a host             | user@host           |
        | followed by a second command | host;evil           |
        | followed by a line break     | host␊               |
        | a shell expression           | $(evil)             |
        | two words                    | host space          |

    Scenario Outline: A workspace that is <what> is refused
      Given the worker "dev-one" has the field "workspace" set to "<workspace>"
      When the roster is read
      Then it is refused

      Examples:
        | what                       | workspace    |
        | a relative path            | relative     |
        | left for a shell to expand | ~/repo       |
        | two lines                  | /repo␊secret |
        | followed by a NUL byte     | /repo␀       |

    Scenario Outline: A roster is refused when <problem>
      Given <change>
      When the roster is read
      Then it is refused

      Examples:
        | problem                       | change                                                      |
        | its version is not 1          | the roster has the version 2                                |
        | it carries a field of its own | the roster has the field "token" set to "never-print-this"  |
        | a worker carries a command    | the worker "dev-one" has the field "command" set to "evil"  |
        | a worker is listed twice      | the roster lists the worker "dev-one" 2 times and no other  |
        | it lists no worker            | the roster lists no worker                                  |
        | it lists more than 64 workers | the roster lists the worker "dev-one" 65 times and no other |

  Rule: Workers are selected by id, and a name the roster does not hold selects nothing

    Background:
      Given a roster of these workers:
        | id      | ssh     | workspace           | required |
        | dev-one | dev-one | /home/dev/workspace | nothing  |
        | other   | dev-one | /home/dev/workspace | nothing  |

    Scenario: Naming no worker selects every worker
      When no worker is named to select from the roster
      Then the workers selected are, in this order:
        | dev-one |
        | other   |

    Scenario: A named worker is selected alone
      When the worker "other" is selected from the roster
      Then the workers selected are, in this order:
        | other |

    Scenario: A name the roster does not hold is refused
      When the worker "typo" is selected from the roster
      Then it is refused

  Rule: The roster is published as an example and a schema

    Scenario: The example roster is one the manager accepts
      When the roster at "examples/roster.json" is read
      Then it lists 1 worker

    Scenario Outline: The published schema <verdict> the workspace "<workspace>"
      Then the workspace pattern of "schema/roster.schema.json" <verdict> "<workspace>"

      Examples:
        | verdict | workspace                   |
        | accepts | /home/name with spaces/repo |
        | rejects | /home/name␊                 |

  Rule: Only the workers the fleet configuration declares are enrolled
    A portable fleet configuration does not authorize a peer the manager
    happened to find, and does not invent the paths on a worker: those come
    from the roster, for workers the configuration already names.

    Background:
      Given the example fleet configuration
      And it requires every worker to have:
        | github      |
        | vault       |
        | t3          |
        | toolchain   |
        | workstation |
        | worker      |

    Scenario: An enrolled worker keeps the path its entry gives and gains every requirement
      Given a roster of these workers:
        | id         | ssh        | workspace    | required |
        | worker-two | worker-two | /a real/path | nothing  |
      When the manager enrolls the workers of the roster
      Then the workers enrolled are:
        | id         | ssh        | workspace    | required                                          |
        | worker-two | worker-two | /a real/path | github, vault, t3, toolchain, workstation, worker |

    Scenario: A worker the fleet configuration does not declare is refused
      Given a roster of these workers:
        | id         | ssh        | workspace    | required |
        | discovered | worker-two | /a real/path | nothing  |
      When the manager enrolls the workers of the roster
      Then it is refused

    Scenario: A roster entry cannot move a declared worker to another SSH name
      Given a roster of these workers:
        | id         | ssh   | workspace    | required |
        | worker-two | other | /a real/path | nothing  |
      When the manager enrolls the workers of the roster
      Then it is refused, saying "conflicts"
