@posix
Feature: The bootstrap finishes an interrupted package run before it installs its prerequisites
  A sync cut off while a package was being installed or upgraded (the
  session dropped, the machine lost power) leaves dpkg with packages unpacked
  and not configured. When the bootstrap lacks one of its own packages, as it
  does when the cut-off run was upgrading one, it must use APT, and APT
  refuses to run over an interrupted dpkg. So it finishes that run first with
  dpkg --configure -a, once and bounded, whoever started it, and the next
  sync heals without a person. Only a package database still inconsistent
  afterwards stops the run, with a named code.

  These scenarios run the prerequisites step of
  bootstrap/fleet-remote-bootstrap.sh in a real POSIX shell, with stand-ins
  for sudo, dpkg and apt-get.

  Scenario: A sync cut off while it upgraded one of the bootstrap's own packages is finished, and nothing is installed again
    Given the package "python3" was unpacked and not configured when the run was cut off
    And dpkg finishes configuring what is unpacked
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And dpkg was asked to configure every unpacked package 1 time
    And APT installed nothing

  Scenario: A run someone else started and that was cut off is finished, then what the bootstrap lacks is installed
    Given the package "zip" was unpacked and not configured when the run was cut off
    And the bootstrap package "unzip" is not installed
    And dpkg finishes configuring what is unpacked
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And dpkg was asked to configure every unpacked package 1 time
    And APT installed "unzip"

  Scenario: A package process that holds the lock is waited for, then the run is finished
    Given the package "python3" was unpacked and not configured when the run was cut off
    And another package process holds the dpkg lock for the first 3 attempts
    And dpkg finishes configuring what is unpacked
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And dpkg was asked to configure every unpacked package 4 times
    And the bootstrap waited 3 times for the lock

  Scenario: A lock held past the bound stops the bootstrap with APT_LOCK_CONTENDED
    Given the package "python3" was unpacked and not configured when the run was cut off
    And another package process holds the dpkg lock for the first 100 attempts
    When the prerequisites step runs
    Then the bootstrap stops its prerequisites with "APT_LOCK_CONTENDED"
    And dpkg was asked to configure every unpacked package 25 times
    And APT installed nothing

  Scenario: A run the repair cannot finish stops the bootstrap with DPKG_INTERRUPTED
    Given the package "python3" was unpacked and not configured when the run was cut off
    And dpkg cannot finish configuring what is unpacked
    When the prerequisites step runs
    Then the bootstrap stops its prerequisites with "DPKG_INTERRUPTED"
    And dpkg was asked to configure every unpacked package 1 time
    And APT installed nothing

  Scenario: A consistent package database is left alone
    Given the bootstrap package "unzip" is not installed
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And dpkg was asked to configure every unpacked package 0 times
    And APT installed "unzip"

  Scenario: The marker an earlier revision left for its own installation is removed
    Earlier revisions finished only a run they had marked as their own; the
    repair no longer asks, so the marker has no reader and goes.
    Given the bootstrap package "unzip" is not installed
    And an earlier revision left its installation marker
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And the installation marker is gone

  Scenario: A machine that holds every prerequisite needs no sudo and no APT here
    The Ubuntu baseline repairs an interrupted run of a package the
    bootstrap does not need (ansible/ubuntu/tasks/dpkg.yml).
    Given the package "zip" was unpacked and not configured when the run was cut off
    When the prerequisites step runs
    Then the bootstrap goes on past its prerequisites
    And dpkg was asked to configure every unpacked package 0 times
    And sudo was never used
