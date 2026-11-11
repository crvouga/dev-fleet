Feature: Which machines the manager converges
  Every machine answers one probe with three lines: its family, its release
  and its CPU. Ubuntu 26.04 is the accepted worker baseline, macOS 14 or newer
  is best effort, and a machine that answers as something other than what the
  fleet configuration declares is refused.

  Scenario Outline: A machine declared as <declared> that reports <family> <release> on <cpu> is <verdict>
    When a machine declared as "<declared>" answers the probe with "<family>", "<release>" and "<cpu>"
    Then the "<check>" check says the machine is <verdict>
    And the baseline is summarised as "<summary>"

    Examples: Ubuntu 26.04 on a supported CPU is the accepted worker baseline
      | declared | family | release | cpu     | check          | verdict       | summary                                               |
      | linux    | ubuntu | 26.04   | x86_64  | ubuntu:release | supported     | Ubuntu 26.04 and supported CPU architecture observed. |
      | linux    | ubuntu | 26.04   | aarch64 | ubuntu:release | supported     | Ubuntu 26.04 and supported CPU architecture observed. |
      | linux    | ubuntu | 24.04   | x86_64  | ubuntu:release | not supported | UBUNTU_BASELINE_MISMATCH                              |

    Examples: macOS 14 or newer is best effort; older releases fail
      | declared | family | release | cpu    | check         | verdict       | summary                                                                                   |
      | macOS    | macos  | 15.2    | arm64  | macos:release | supported     | macOS 14 or newer and a supported CPU architecture observed; macOS policy is best effort. |
      | macOS    | macos  | 13.6.1  | x86_64 | macos:release | not supported | MACOS_BASELINE_MISMATCH                                                                   |

    Examples: A machine that is not what the fleet configuration declares fails
      | declared | family | release | cpu    | check          | verdict       | summary                  |
      | macOS    | ubuntu | 26.04   | x86_64 | macos:release  | not supported | MACOS_BASELINE_MISMATCH  |
      | linux    | macos  | 15.2    | arm64  | ubuntu:release | not supported | UBUNTU_BASELINE_MISMATCH |

  Scenario Outline: A machine declared as <declared> is <converged>
    Windows machines stay declared in the fleet configuration but never
    receive manager convergence.
    Then a machine declared as "<declared>" is <converged>

    Examples:
      | declared | converged     |
      | windows  | not converged |
      | macOS    | converged     |
      | linux    | converged     |
