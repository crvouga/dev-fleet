@posix
Feature: The bootstrap waits for the machine's own first boot before any package work
  A new machine answers SSH before its first boot has finished: cloud-init
  may still be growing the disk and installing packages. The remote
  bootstrap waits for it, within a bound, before it touches a package. A
  first boot that never finishes is a retryable FIRST_BOOT_PENDING; one that
  ended in an error stops the run, so a half-provisioned image is never
  converged. A machine without cloud-init has nothing to wait for.

  These scenarios run the first-boot step of
  bootstrap/fleet-remote-bootstrap.sh in a real POSIX shell, with a stand-in
  for cloud-init.

  Scenario Outline: A first boot that <ends> lets the bootstrap go on
    Given cloud-init reports its first boot finished with the exit code <code>
    When the first-boot step runs with a bound of 5 seconds
    Then the bootstrap goes on
    And cloud-init was asked to wait for the first boot

    Examples:
      | ends                             | code |
      | finished                         | 0    |
      | finished with recoverable errors | 2    |

  Scenario: A first boot that ended in an error stops the bootstrap
    Given cloud-init reports its first boot finished with the exit code 1
    When the first-boot step runs with a bound of 5 seconds
    Then the bootstrap stops with "FIRST_BOOT_FAILED"

  Scenario: A first boot that never finishes is reported as pending within the bound
    Given cloud-init never finishes the first boot
    When the first-boot step runs with a bound of 1 seconds
    Then the bootstrap stops with "FIRST_BOOT_PENDING"
    And it stopped within 5 seconds

  Scenario: A machine without cloud-init skips the wait
    Given the machine has no cloud-init
    When the first-boot step runs with a bound of 5 seconds
    Then the bootstrap goes on

  Scenario: A pending first boot is retryable; a failed one needs a person
    Then the diagnostic of "FIRST_BOOT_PENDING" is retryable
    And the diagnostic of "FIRST_BOOT_FAILED" is not retryable
