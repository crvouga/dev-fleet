Feature: A worker's manifest proves it can be rebuilt
  devfleet fleet-manifest measures what a worker is made of: every installed
  package, the active mise tools and the state of each always-on service. Two
  workers built from the same revision have the same manifest and the same
  digest. The check worker:manifest reports every difference from the pins
  ansible/ubuntu/policy.json declares and, given a fresh build's manifest,
  from that build: what a long-lived worker gained out of band shows up.

  Background:
    Given the roster entry "worker-one", with the workspace "/home/dev/.local/share/personal/fleet"
    And a worker with every package and service policy.json declares, and these tools:
      | node | 24.11.0 |
      | bun  | 1.4.4   |

  Scenario: Two builds from the same revision have identical manifests, whatever order they list in
    Given the manifest of the worker was measured
    When the manifest of a second build, listing everything in reverse order, is measured
    Then both manifests and their digests are identical

  Scenario: A worker like its fresh build passes
    Given the fresh build's manifest is the worker's own
    When the operator runs fleet-manifest for "worker-one" against the fresh build
    Then the command exits with 0
    And the reported check "worker:manifest" passes

  Scenario: A package installed out of band shows up in worker:manifest
    Given the fresh build's manifest is the worker's own
    And someone installed the package "cowsay" at "3.03+dfsg2-8" on the worker
    When the operator runs fleet-manifest for "worker-one" against the fresh build
    Then the command exits with 1
    And the check "worker:manifest" fails, naming "packages:cowsay absent -> 3.03+dfsg2-8"

  Scenario: A pinned package at another version fails, even without a fresh build
    Given someone upgraded the package "curl" to "9.0.0-1" on the worker
    When the operator runs fleet-manifest for "worker-one"
    Then the command exits with 1
    And the check "worker:manifest" fails, naming "packages:curl"

  Scenario: Measuring changes nothing on the worker
    When the operator runs fleet-manifest for "worker-one"
    Then the worker was asked only to list, with dpkg-query, mise ls and systemctl is-enabled and is-active
