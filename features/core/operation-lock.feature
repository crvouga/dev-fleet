Feature: One operation at a time on a machine
  A remote operation takes a lock before it changes anything, so two syncs
  never run on one machine at once. The lock belongs to the shell's open file
  descriptor 9 and lasts until whatever holds that descriptor has exited.

  Scenario: The lock is taken with flock where there is one, and through Python where there is not
    Linux has flock(1); macOS does not, so the same descriptor is locked
    through Python's fcntl.
    When the lock prelude of a remote operation is written
    Then it contains "flock -n 9"
    And it contains "fcntl.LOCK_EX | fcntl.LOCK_NB"
    And a POSIX shell parses it

  Scenario Outline: <script> parses on the shell of this machine
    These scripts are sent to a machine before any toolchain is there.
    Then a POSIX shell parses the script "<script>"

    Examples:
      | script                              |
      | bootstrap/fleet-remote-bootstrap.sh |
      | ansible/ubuntu/authorize-sudo.sh    |

  @linux
  Scenario: An installer keeps the lock after the process that started it is killed
    A command started with the lock kept inherits descriptor 9, so a second
    operation cannot begin while an orphaned installer is still running.
    Given a shell that holds the operation lock and starts an installer that runs for 2 seconds with the lock kept
    When the shell is killed while the installer runs
    Then the installer had been started
    And the operation lock cannot be taken
    And the operation lock can be taken once the installer has ended
