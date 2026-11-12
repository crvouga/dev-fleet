Feature: The manager runs the T3 release the workers run
  Workers get a pinned, checksum-verified T3 with updates off by policy. The
  manager gets the same pin and the same policy, so the IDE that drives the
  workers never runs another release and never updates itself.

  Scenario Outline: The pinned server archive for <platform> <architecture> is <file>
    When the pinned T3 archive for <platform> <architecture> is resolved
    Then it is the file "<file>" with a SHA-256 digest from mise.toml

    Examples:
      | platform | architecture | file                                            |
      | linux    | x64          | t3-0.1.8-nightly.20261106.4262-linux-x64.tar.gz  |
      | linux    | arm64        | t3-0.1.8-nightly.20261106.4262-linux-arm64.tar.gz |
      | darwin   | arm64        | t3-0.1.8-nightly.20261106.4262-darwin-arm64.tar.gz |

  Scenario: No T3 is pinned for a Mac on Intel
    Upstream publishes no server archive for it.
    When the pinned T3 archive for darwin x64 is resolved
    Then no archive is pinned

  Rule: Every machine reports the version it runs

    Scenario Outline: The manager running <running> <outcome>
      Given T3 on the manager last started as "<running>"
      When the T3 version of the manager is checked
      Then the check "t3:version" <outcome>

      Examples:
        | running                     | outcome                           |
        | 0.1.8-nightly.20261106.4262 | passes                            |
        | 0.1.9-nightly.20261111.4501 | warns with "T3_VERSION_SKEW"      |
        |                             | warns with "T3_VERSION_UNKNOWN"   |

    Scenario: A worker reports its version over SSH
      Given the worker "worker-one" says over SSH that its T3 last started as "0.1.9-nightly.20261111.4501"
      When the T3 version of the worker "worker-one" is checked
      Then the check "t3:version" warns with "T3_VERSION_SKEW"
      And the remedy of the check "t3:version" mentions "the fleet pins 0.1.8-nightly.20261106.4262"

  Rule: T3 on the manager does not update itself

    Scenario Outline: A policy with updates <mode> <outcome>
      Given the T3 administrator policy on the manager is:
        """
        <policy>
        """
      When the T3 updater of the manager is checked
      Then the check "t3:updates" <outcome>

      Examples:
        | mode           | policy                                           | outcome                             |
        | off            | { "limits": { "updates": { "mode": "off" } } }   | passes                              |
        | on             | { "limits": { "updates": { "mode": "auto" } } }  | warns with "T3_UPDATES_UNMANAGED"   |
        | not configured | {}                                               | warns with "T3_UPDATES_UNMANAGED"   |

    Scenario: The manager's playbook stages the workers' policy where T3 on macOS reads it
      When the manager's T3 playbook is read
      Then it installs "../ubuntu/t3/policy.json" at "/Library/Application Support/T3Code/policy.json"
      And it records the ownership marker "ansible/ubuntu/t3/policy.json"
      And "ansible/macos/manager.yml" imports it
