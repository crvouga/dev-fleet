Feature: The manager installs the agent on a worker over SSH
  Only the agent's own enrollment crosses SSH, on standard input; the hub
  account stays on the manager. The worker applies it from the revision it
  already holds, under the lock every remote operation takes, and answers with
  checks. Anything else it answers is refused without being repeated.

  Scenario: Only the agent's enrollment is sent to the worker
    A worker never hosts the hub, so the request names no mode.
    Given the agent is enrolled as:
      | system     | abcdefghijklmno                     |
      | hub        | https://manager.example.ts.net:8443 |
      | public key | ssh-ed25519 fixture                 |
      | token      | never-output-token                  |
    And the worker answers over SSH with:
      """
      {"version":1,"checks":[{"id":"beszel:service","status":"pass","summary":"ok"}]}
      """
    When the manager installs the agent on the worker "worker-one" at the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    Then the worker's checks are exactly:
      | beszel:service |
    And the worker was sent exactly, on standard input:
      """
      {
        "systemId": "abcdefghijklmno",
        "hubUrl": "https://manager.example.ts.net:8443",
        "publicKey": "ssh-ed25519 fixture",
        "token": "never-output-token",
        "node": "worker-one",
        "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      """
    And what the worker was sent does not contain '"mode"'

  Scenario: An answer that is not a report of checks is refused and not repeated
    Given the agent is enrolled as:
      | system     | abcdefghijklmno                     |
      | hub        | https://manager.example.ts.net:8443 |
      | public key | ssh-ed25519 fixture                 |
      | token      | never-output-token                  |
    And the worker answers over SSH with:
      """
      raw never-output-token
      """
    When the manager installs the agent on the worker "worker-one" at the revision "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    Then the summary of the check is "BESZEL_REMOTE_EVIDENCE_INVALID"
    And the checks do not contain "never-output"

  @linux
  Scenario: A worker whose remote operation lock is held says so, and nothing is started
    The lock is taken with the real flock(1) in a temporary home, which only
    Linux has. The worker's toolchain is not in that home: had the lock not
    stopped the operation, starting mise would have failed instead.
    Given the agent is enrolled as:
      | system     | abcdefghijklmno                     |
      | hub        | https://fixture.example.ts.net:8443 |
      | public key | ssh-ed25519 fixture                 |
      | token      | disposable-fixture-token            |
    And a worker's home that holds the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And another operation holds the remote operation lock of that home
    When the manager installs the agent on the worker "fixture" at the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the check is "beszel:lock"
    And the summary of the check is "FLEET_REMOTE_LOCKED"
    And the check fails
