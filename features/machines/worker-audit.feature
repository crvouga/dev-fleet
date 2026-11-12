Feature: A worker is audited without changing or revealing anything
  The audit reads the Ubuntu release, the CPU architecture and the versions of
  the packages the policy pins. It reports those and nothing else: no package
  source, account, environment or raw error.

  Scenario: An Ubuntu release other than the policy's is not supported, and nothing a command wrote is repeated
    The Ubuntu policy pins release 26.04 and names the package "sudo", not
    "unknown".
    Given these commands answer:
      | command                   | answer                                 |
      | cat /etc/os-release       | prints ID=ubuntu\nVERSION_ID="24.04"\n |
      | dpkg --print-architecture | prints amd64\n                         |
      | dpkg-query -W …           | prints sudo\t1.9.17\nunknown\tSECRET\n |
    And every other command succeeds
    And every command also writes "SECRET" to its error stream
    When the worker is audited
    Then the audit says the worker is not supported
    And the audit lists exactly these packages:
      | package | version |
      | sudo    | 1.9.17  |
    And the audit does not contain "SECRET"
    And no command with any of these words was run:
      | install |
      | enable  |
      | restart |
      | up      |
      | login   |
      | update  |

  Scenario Outline: A pinned package installed <situation> its pin <verdict>
    A pin is a minimum. Ubuntu installs security updates by itself and they
    keep flowing, so a package moved past its pin is reported and kept: the
    worker is not turned red by a security update, and nothing downgrades it.
    When the package "curl" pinned at "8.18.0-1ubuntu2.8" is measured installed at "<installed>"
    Then the check is "worker:package:curl"
    And the check <verdict>
    And the summary of the check is "<summary>"

    Examples:
      | situation | installed          | verdict | summary                                                         |
      | at        | 8.18.0-1ubuntu2.8  | passes  | Installed at the version the policy pins.                       |
      | above     | 8.18.0-1ubuntu2.10 | warns   | PACKAGE_NEWER_THAN_PIN curl 8.18.0-1ubuntu2.10, pinned 8.18.0-1ubuntu2.8 |
      | above     | 1:8.0-1            | warns   | PACKAGE_NEWER_THAN_PIN curl 1:8.0-1, pinned 8.18.0-1ubuntu2.8   |
      | below     | 8.18.0-1ubuntu2    | fails   | PACKAGE_BELOW_PIN curl 8.18.0-1ubuntu2, pinned 8.18.0-1ubuntu2.8 |
      | below     | 8.18.0-1ubuntu2.8~rc1 | fails | PACKAGE_BELOW_PIN curl 8.18.0-1ubuntu2.8~rc1, pinned 8.18.0-1ubuntu2.8 |
      | without   |                    | fails   | PACKAGE_BELOW_PIN curl missing, pinned 8.18.0-1ubuntu2.8        |

  Scenario: A release's own package pins replace the common pins of the Ubuntu policy
    Adding a release is one entry in the policy with the pins that differ
    for it; every other package keeps its common pin.
    When the pins of a release that pins "curl" at "8.5.0-2ubuntu10.6" are read
    Then "curl" is pinned at "8.5.0-2ubuntu10.6"
    And every package but "curl" is pinned at the common pin of the Ubuntu policy
