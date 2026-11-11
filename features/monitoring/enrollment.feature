Feature: A machine is enrolled in the hub once
  The manager registers a machine through the hub's own API: one system record
  and one fingerprint, which holds the agent's token. Enrolling can be
  repeated: a run that was interrupted resumes what it had stored, and a
  repeat returns the same token. A registration that is not this machine's is
  never adopted.

  Background:
    Given a hub of release "0.21.1" whose key is "ssh-ed25519 fixture"
    And the manager is signed in to the hub "https://hub.example.ts.net:8443" as the user "abcdefghijklmno"

  Scenario: A failure while the fingerprint is stored interrupts the enrollment
    Given the hub fails the first time a fingerprint is stored
    When the machine "devbox" at "devbox.example.ts.net" is enrolled
    Then the enrollment fails

  Scenario: An interrupted enrollment resumes its system record and keeps its token on a repeat
    Given the hub fails the first time a fingerprint is stored
    And an enrollment of the machine "devbox" at "devbox.example.ts.net" was interrupted
    And the machine "devbox" at "devbox.example.ts.net" was enrolled
    When the machine "devbox" at "devbox.example.ts.net" is enrolled
    Then the enrollment is the same as the one before
    And the hub was asked to create 1 system record in all

  Scenario Outline: <which registration> is never silently adopted
    Given the hub already lists these system records:
      """
      <records>
      """
    When the machine "devbox" at "devbox.example.ts.net" is enrolled
    Then the enrollment fails with "<refusal>"
    And nothing was written to the hub

    Examples:
      | which registration                            | records                                                  | refusal               |
      | A registration of the name at another address | [{"id":"abcdefghijklmno","host":"other.example.ts.net"}] | BESZEL_HOST_CONFLICT  |
      | A registration that exists twice              | [{},{}]                                                  | BESZEL_DUPLICATE_NODE |
