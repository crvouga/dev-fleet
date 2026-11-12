Feature: Which machines the manager converges
  Every worker answers one probe: its family, its release, its CPU, the
  environment it runs in, the hypervisor it runs on, its CPU count, its memory
  and the size of its root filesystem. A worker runs an Ubuntu release the
  Ubuntu policy accepts, on a CPU that release lists, on a machine of its own
  at least the size of the minimum worker. The probe records whether that
  machine is physical or virtual. docs/support-matrix.md lists every platform
  and what happens to it.

  Scenario Outline: A worker that reports <family> <release> on <cpu> is <verdict>
    When a worker answers the probe with "<family>", "<release>", "<cpu>" and "machine"
    Then the "ubuntu:release" check says the worker is <verdict>
    And the baseline is summarised as "<summary>"

    Examples: Ubuntu 26.04 and 24.04 on a supported CPU are the accepted worker baselines
      | family | release | cpu     | verdict       | summary                                               |
      | ubuntu | 26.04   | x86_64  | supported     | Ubuntu 26.04 and supported CPU architecture observed. |
      | ubuntu | 26.04   | aarch64 | supported     | Ubuntu 26.04 and supported CPU architecture observed. |
      | ubuntu | 24.04   | x86_64  | supported     | Ubuntu 24.04 and supported CPU architecture observed. |
      | ubuntu | 24.04   | aarch64 | supported     | Ubuntu 24.04 and supported CPU architecture observed. |

    Examples: Anything else is refused: another release, another CPU, another family
      | family | release | cpu     | verdict       | summary                  |
      | ubuntu | 22.04   | x86_64  | not supported | UBUNTU_BASELINE_MISMATCH |
      | ubuntu | 24.04   | riscv64 | not supported | UBUNTU_BASELINE_MISMATCH |
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

  Scenario Outline: The probe records <what> as a <class> machine
    A virtual machine has no lid and no firmware its guest can read, and its
    provider restarts it after a power loss: the checks of those do not apply
    to it. systemd-detect-virt names the hypervisor, or "none" on bare metal.
    Given a root whose kernel release reads "6.8.0-45-generic" and that holds the files:
      |  |
    And systemd-detect-virt there reports "<hypervisor>"
    And its memory reads "MemTotal:        8131476 kB" and its CPUs number 4
    When the probe runs there
    Then it prints the environment "machine"
    And it prints the hypervisor "<hypervisor>"
    And it prints 4 CPUs and 7940 MiB of memory
    And the machine class is recorded as "<summary>"

    Examples:
      | what        | hypervisor | class    | summary                                                                                     |
      | a KVM guest | kvm        | virtual  | Virtual machine (kvm): checks of firmware power recovery and of a lid do not apply.        |
      | bare metal  | none       | physical | Physical machine (systemd-detect-virt reported none).                                       |

  Scenario Outline: A worker with <size> is <verdict>
    The minimum worker is declared once, under sizing.minimumWorker in the
    Ubuntu policy: 2 CPUs, 3584 MiB of memory (a 4 GiB instance after the
    kernel takes its share) and a 20480 MiB root filesystem. A smaller
    machine is refused before anything is installed on it.
    When a worker reports <cpus> CPUs, <memory> MiB of memory and a <disk> MiB root filesystem
    Then the "platform:worker-size" check says the worker is <verdict>, with "<summary>"

    Examples:
      | size                                | cpus | memory | disk   | verdict       | summary                                         |
      | the minimum                         | 2    | 3584   | 20480  | supported     | 2 CPUs, 3584 MiB of memory                      |
      | a small rented instance             | 2    | 7940   | 40960  | supported     | 2 CPUs, 7940 MiB of memory                      |
      | too little memory                   | 2    | 1983   | 40960  | not supported | WORKER_SIZE_BELOW_MINIMUM: memory 1983 MiB < 3584 MiB |
      | too small a disk                    | 4    | 7940   | 10240  | not supported | WORKER_SIZE_BELOW_MINIMUM: disk 10240 MiB < 20480 MiB |
      | one CPU                             | 1    | 7940   | 40960  | not supported | WORKER_SIZE_BELOW_MINIMUM: CPUs 1 < 2           |

  Scenario: A worker whose probe reports no size is not judged by it
    Then a worker that reports no size gets no size check

  Scenario: Only Linux machines are workers
    macOS and Windows are not worker platforms: the fleet configuration
    refuses a worker that names either, so no code converges them.
    Then the fleet configuration refuses a worker declared as "macOS"
    And the fleet configuration refuses a worker declared as "windows"

  Scenario: A worker platform names what differs from one platform to another
    Ubuntu is the one worker platform. Another would name its own policy,
    packages, service manager and session model, and its own host checks.
    Then the worker platforms are:
      | family | label  | policy                     | packageManager | serviceManager | sessionModel        |
      | ubuntu | Ubuntu | ansible/ubuntu/policy.json | apt            | systemd        | systemd-user-linger |
    And the worker platform "ubuntu" accepts the releases:
      | release | codename | architectures |
      | 26.04   | resolute | amd64, arm64  |
      | 24.04   | noble    | amd64, arm64  |
