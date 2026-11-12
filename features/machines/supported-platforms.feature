Feature: Which machines the manager converges
  Every worker answers one probe with four lines: its family, its release,
  its CPU and the environment it runs in. A worker runs an Ubuntu release the
  Ubuntu policy accepts, on a CPU that release lists, on a machine of its own.
  docs/support-matrix.md lists every platform and what happens to it.

  Scenario Outline: A worker that reports <family> <release> on <cpu> is <verdict>
    When a worker answers the probe with "<family>", "<release>", "<cpu>" and "machine"
    Then the "ubuntu:release" check says the worker is <verdict>
    And the baseline is summarised as "<summary>"

    Examples: Ubuntu 26.04 on a supported CPU is the accepted worker baseline
      | family | release | cpu     | verdict       | summary                                               |
      | ubuntu | 26.04   | x86_64  | supported     | Ubuntu 26.04 and supported CPU architecture observed. |
      | ubuntu | 26.04   | aarch64 | supported     | Ubuntu 26.04 and supported CPU architecture observed. |

    Examples: Anything else is refused: another release, another CPU, another family
      | family | release | cpu     | verdict       | summary                  |
      | ubuntu | 24.04   | x86_64  | not supported | UBUNTU_BASELINE_MISMATCH |
      | ubuntu | 26.04   | riscv64 | not supported | UBUNTU_BASELINE_MISMATCH |
      | debian | 13      | x86_64  | not supported | UBUNTU_BASELINE_MISMATCH |
      | Darwin |         | arm64   | not supported | UBUNTU_BASELINE_MISMATCH |

  Scenario Outline: A worker running in <environment> is refused by name
    An Ubuntu userland under WSL2 or in a container passes the release check,
    then fails later in confusing ways: no systemd, no display manager, no
    power policy of its own. The probe says so before anything is installed.
    When a worker answers the probe with "ubuntu", "26.04", "x86_64" and "<environment>"
    Then the "platform:environment" check says the worker is <verdict>
    And the environment is summarised as "<summary>"

    Examples:
      | environment | verdict       | summary                                                       |
      | machine     | supported     | A machine of its own observed: not WSL2 and not a container. |
      | wsl         | not supported | WORKER_ENVIRONMENT_UNSUPPORTED: WSL2                          |
      | container   | not supported | WORKER_ENVIRONMENT_UNSUPPORTED: container                     |
      |             | not supported | WORKER_ENVIRONMENT_UNSUPPORTED: unknown environment           |

  Scenario Outline: The probe tells <environment> apart from a machine of its own
    The probe is run by a POSIX shell on the worker; here it is run against
    a stand-in root that holds only the marks <environment> leaves.
    Given a root whose kernel release reads "<kernel>" and that holds the files:
      | <marks> |
    When the probe runs there
    Then it prints the environment "<environment>"

    Examples:
      | environment | kernel                              | marks              |
      | wsl         | 6.6.87.2-microsoft-standard-WSL2    |                    |
      | container   | 6.8.0-45-generic                    | .dockerenv         |
      | container   | 6.8.0-45-generic                    | run/.containerenv  |
      | machine     | 6.8.0-45-generic                    |                    |

  Scenario: Only Linux machines are workers
    macOS and Windows are not worker platforms: the fleet configuration
    refuses a worker that names either, so no code converges them.
    Then the fleet configuration refuses a worker declared as "macOS"
    And the fleet configuration refuses a worker declared as "windows"
