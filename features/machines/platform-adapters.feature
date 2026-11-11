Feature: One adapter for each operating system
  Code never branches on the operating system it runs on. It asks the adapter
  of its platform where things live and what the machine can do.

  Scenario Outline: A machine whose runtime reports "<reported>" is the platform "<platform>"
    Then the operating system "<reported>" is the platform "<platform>"

    Examples:
      | reported | platform |
      | darwin   | darwin   |
      | linux    | linux    |
      | win32    | windows  |
      | freebsd  | unknown  |

  Scenario Outline: The platform "<platform>" has an adapter that names its directories and its notifier
    When the adapter of the platform "<platform>" is asked for
    Then the adapter is named "<platform>"
    And it names a directory for OpenCode, a cache directory and a directory for global commands
    And it says what its notifier can do

    Examples:
      | platform |
      | darwin   |
      | linux    |
      | windows  |
      | unknown  |

  Scenario Outline: The platform "<platform>" cannot build the Swift notifier
    When the adapter of the platform "<platform>" is asked for
    Then it cannot build the Swift notifier

    Examples:
      | platform |
      | linux    |
      | windows  |

  Scenario: Whether macOS can build the Swift notifier depends on the machine, and the answer is steady
    When the adapter of the platform "darwin" is asked for
    Then it gives the same answer each time it is asked whether it can build the Swift notifier
