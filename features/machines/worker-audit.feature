Feature: A worker is audited without changing or revealing anything
  The audit reads the Ubuntu release, the CPU architecture and the versions of
  the packages the policy pins. It reports those and nothing else: no package
  source, account, environment or raw error.

  Scenario: An Ubuntu release other than the policy's is not supported, and nothing a command wrote is repeated
    The Ubuntu policy pins release 26.04 and names the package "sudo", not
    "unknown".
    Given these commands answer:
      | command                   | answer                                 |
      | cat /etc/os-release       | prints ID=ubuntu\nVERSION_ID="24.04"\n |
      | dpkg --print-architecture | prints amd64\n                         |
      | dpkg-query -W …           | prints sudo\t1.9.17\nunknown\tSECRET\n |
    And every other command succeeds
    And every command also writes "SECRET" to its error stream
    When the worker is audited
    Then the audit says the worker is not supported
    And the audit lists exactly these packages:
      | package | version |
      | sudo    | 1.9.17  |
    And the audit does not contain "SECRET"
    And no command with any of these words was run:
      | install |
      | enable  |
      | restart |
      | up      |
      | login   |
      | update  |
