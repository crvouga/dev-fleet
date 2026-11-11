Feature: The probe is sent to a worker whole, over SSH
  A worker needs no dev-fleet package to be inspected. The manager bundles the
  probe from its own source and feeds it to the worker's runtime on standard
  input, in the worker's checkout.

  @posix
  Scenario: The bundled probe runs from standard input in a checkout that holds no dev-fleet package
    Nothing is stubbed but the network: the command an SSH session would run on
    the worker runs in a local shell instead, with the real bundle on its
    standard input.
    Given a checkout that holds no dev-fleet package
    And the worker "dev-one" at the SSH alias "dev-one" works in that checkout
    And the runtime of the worker is the Bun that runs these features
    And an SSH session runs its command in a local shell
    When the manager probes the worker with the probe bundled from the current source
    Then the first check is "ssh:session"
    And the snapshot is of version 1
    And the "workspace-manifests" hash of the snapshot is 64 hexadecimal characters
    And the check "vscode:forwarding" has the status "skip"
