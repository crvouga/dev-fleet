Feature: The installer leaves evidence of how far it got
  A worker's bootstrap is watched from the manager through one small file.
  It holds nonsecret evidence only: a phase, a status and a known code, never
  a command, a path or the text of an error.

  Rule: Installer evidence is private, versioned and refuses symlink destinations

    Scenario: The status file holds the latest report and only its owner can read it
      Given the installer has reported the phase "t3" as "running"
      When the installer reports the phase "t3" as "failed"
      Then the status file holds:
        """
        { "version": 1, "phase": "t3", "status": "failed" }
        """
      And only its owner can read or write the status file

    Scenario: A status file that is a symlink is refused and what it points at is untouched
      Given a file "untouched" beside the status file that holds "preserved"
      And the status file is a symlink to "untouched"
      When the installer reports the phase "mise" as "running"
      Then it is refused with "Unsafe setup status"
      And "untouched" beside the status file still holds "preserved"

  Rule: Installer diagnostics never serialize arbitrary exception messages

    Scenario: An error the installer does not know has no code
      When the installer fails with the error "PRIVATE_SENTINEL token=value"
      Then no failure code is recorded

    Scenario: A known failure is recorded as its code
      When the installer fails with the error "Pinned T3 executable verification failed."
      Then the failure code "T3_EXECUTABLE_FAILED" is recorded
