Feature: What a machine becomes is declared, once
  Anything that changes a machine is an Ansible task or a mise pin, and a
  version or digest is written in one tracked file. The tables of exceptions
  here are what is not declared yet (docs/declared.md); they may only shrink.

  Rule: Only a playbook or a pin changes a machine

    Scenario: Playbooks use builtin modules and never a shell
      When every task of every playbook is read
      Then there are more than 100 tasks
      And every task uses an "ansible.builtin" module
      But no task uses any of these modules:
        | shell  |
        | raw    |
        | script |

    Scenario: A package a playbook installs names its exact version
      When every task of every playbook is read
      Then no package is installed in the state "latest"
      And only these packages are installed without an exact version:
        | playbook                           | package                    |
        | ansible/ubuntu/t3-desktop.yml      | {{ t3_desktop_libraries }} |
        | ansible/ubuntu/tasks/resources.yml | systemd-oomd               |

    Scenario: A download a playbook makes is checked against a pinned digest
      When every task of every playbook is read
      Then at least one task downloads a file
      And every download carries a "sha256" checksum

    Scenario: TypeScript changes a machine only through a playbook or a pin
      When the TypeScript sources are searched for commands that change a machine
      Then more than 100 source files were searched
      And only these files run such a command:
        | src/cli/fleet-sync-schedule.ts |
        | src/platform/launchd.ts        |
        | src/platform/systemd-user.ts   |

  Rule: A version or digest is written in one place

    Scenario Outline: mise is pinned with the digest of its archive for <platform>
      Then mise.toml pins the version of mise as a release number
      And mise.toml holds a SHA-256 digest named "mise_<platform>_sha256"

      Examples:
        | platform    |
        | linux_x64   |
        | linux_arm64 |
        | macos_x64   |
        | macos_arm64 |

    Scenario: The bootstrap script reads the mise pin and carries none of its own
      Then "bootstrap/bootstrap.sh" contains "MISE_VERSION=$(pin min_version)"
      But "bootstrap/bootstrap.sh" names no mise release number
      And "bootstrap/bootstrap.sh" does not contain "SHASUMS"

    Scenario: The Windows bootstrap installs the same mise
      Then "bootstrap/bootstrap.ps1" sets $MiseVersion to the mise version mise.toml pins

    Scenario: CI installs the mise version every machine gets
      When the steps of the "CI" workflow that install mise are read
      Then there is at least one
      And each installs the mise version mise.toml pins
      And each names the tools it installs

    Scenario: The Ansible the manager runs is one locked release on one Python
      Then "ansible/pyproject.toml" requires one exact Python version
      And "ansible/pyproject.toml" depends on one exact ansible-core version
      And "ansible/uv.lock" locks that ansible-core version
      And "ansible/uv.lock" records SHA-256 hashes

    Scenario: The Beszel release is named once, in its lock
      Then the "hub" service in "ansible/monitoring/compose.yml" runs the image "image" of the Beszel lock
      And the "cloudflared" service in "ansible/monitoring/compose.yml" runs the image "tunnelImage" of the Beszel lock
      And the hub image of the Beszel lock is the locked version, pinned by digest
      And the agent unit starts the agent from the directory of the locked version
      And none of these files names the locked Beszel version:
        | ansible/monitoring/agent.yml            |
        | ansible/monitoring/agent-darwin.yml     |
        | ansible/monitoring/hub-darwin.yml       |
        | ansible/monitoring/hub-route-darwin.yml |
        | src/monitoring/beszel.ts                |
        | src/monitoring/enroll.ts                |

    Scenario: What bootstrap installs before Ansible exists is pinned by the policy right after
      When the packages "bootstrap/fleet-remote-bootstrap.sh" installs are read
      Then each is a package the Ubuntu policy pins

    Scenario Outline: <script> names the releases the policy names
      Then "<script>" requires the Ubuntu release of the Ubuntu policy
      And "<script>" requires the minimum macOS version of the macOS policy

      Examples:
        | script                              |
        | bootstrap/fleet-remote-bootstrap.sh |
        | ansible/ubuntu/authorize-sudo.sh    |

    Scenario: No policy value is declared without something that applies or measures it
      When every key of the macOS and Ubuntu policies is looked up in the playbooks, the sources and these features
      Then every key is read somewhere

  Rule: CI runs what machines run

    Scenario Outline: Every action in <workflow> runs at a named commit
      When the actions "<workflow>" uses are read
      Then there is at least one
      And each is pinned to a full commit, with its release in a comment

      Examples:
        | workflow                      |
        | .github/workflows/ci.yml      |
        | .github/workflows/release.yml |

    Scenario Outline: <workflow> takes nothing from the runner's distribution
      Then "<workflow>" does not contain "apt-get install"
      And "<workflow>" does not contain "setup-python"

      Examples:
        | workflow                      |
        | .github/workflows/ci.yml      |
        | .github/workflows/release.yml |

    Scenario: The package manager is the Bun that mise pins
      Then package.json names the Bun version mise.toml pins as its package manager
