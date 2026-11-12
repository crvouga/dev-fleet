Feature: The manager runs on a host behind one interface, and comes back by itself
  How the manager is named, kept awake, supervised and brought back after a
  power cut is one interface with a macOS and a Linux implementation. macOS is
  the default and the reference. Every scenario here runs against both.

  Scenario Outline: The <host> manager supervises with <services> and hosts its services in <engine>
    Then the <host> manager supervises its services with "<services>"
    And the <host> manager hosts its services in "<engine>"
    And the <host> manager keeps its services' data under "<data>" in the home directory

    Examples:
      | host  | services | engine         | data                       |
      | macOS | launchd  | Docker Desktop | Library/Application Support |
      | Linux | systemd  | Docker Engine  | .local/share               |

  Scenario Outline: The <host> manager is the declared manager when its local host name is the manager's id
    Given the <host> manager's local host name is "manager-mac"
    When the identity of the <host> manager is measured against "manager-mac"
    Then the check's status is "pass"

    Examples:
      | host  |
      | macOS |
      | Linux |

  Scenario Outline: Another <host> machine is not the manager
    Given the <host> manager's local host name is "worker-one"
    When the identity of the <host> manager is measured against "manager-mac"
    Then the check's summary is "FLEET_NOT_MANAGER"

    Examples:
      | host  |
      | macOS |
      | Linux |

  Scenario Outline: A <host> manager that never sleeps passes its power policy
    Given the <host> manager meets its power policy
    When the power policy of the <host> manager is measured
    Then the check's status is "pass"

    Examples:
      | host  |
      | macOS |
      | Linux |

  Scenario Outline: A <host> manager that may sleep fails its power policy
    Given the <host> manager meets its power policy, except "<setting>"
    When the power policy of the <host> manager is measured
    Then the check's status is "fail"

    Examples:
      | host  | setting        |
      | macOS | autorestart    |
      | Linux | suspend.target |

  Rule: A manager comes back by itself after a power cut

    Scenario Outline: A <host> manager with everything in place passes manager:boot-recovery
      Given the <host> manager has everything that brings it back after a power cut
      When the boot recovery of the <host> manager is measured
      Then the check's status is "pass"

      Examples:
        | host  |
        | macOS |
        | Linux |

    Scenario Outline: A <host> manager without <missing> fails with a remedy
      Given the <host> manager has everything that brings it back after a power cut, except "<missing>"
      When the boot recovery of the <host> manager is measured
      Then the check's status is "fail"
      And the check's summary is "MANAGER_BOOT_RECOVERY_INCOMPLETE <missing>"
      And the check's remedy contains "<remedy>"

      Examples:
        | host  | missing          | remedy                       |
        | macOS | autorestart      | ansible/macos/manager.yml    |
        | macOS | docker-autostart | Docker Desktop does not start at login |
        | macOS | launch-agents    | dev.devfleet.beszel-agent    |
        | Linux | linger           | loginctl linger is off       |
        | Linux | docker-autostart | Docker Engine does not start at boot |

    Scenario: A Mac with FileVault on warns that a power cut needs a person
      Given the macOS manager has everything that brings it back after a power cut, except "login"
      And FileVault is on on the macOS manager
      When the boot recovery of the macOS manager is measured
      Then the check's status is "warn"
      And the check's summary is "MANAGER_BOOT_RECOVERY_INCOMPLETE login"
      And the check's remedy contains "waits at the login window until a person signs in"

    Scenario: The manager policy declares autorestart and Docker Desktop at login, and the playbook applies both
      Then the manager's policy declares "autorestart" as "1"
      And the manager's playbook turns on the Docker Desktop setting the policy names
