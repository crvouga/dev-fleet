Feature: A checkout is compared with the manager's by its commit and its input files
  The fingerprint of a checkout is its commit and a hash of every file that
  decides which tools and dependencies get installed. Two checkouts are in
  sync when their fingerprints match, and a checkout's dependencies are
  verified when the receipt of its last frozen sync matches its fingerprint.

  Background:
    Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Rule: Checkouts are in sync when the commit and every input hash match

    Scenario: A checkout matches itself
      When the fingerprint of the checkout is compared with itself
      Then the fingerprint names the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And every check has passed

    Scenario: A checkout without workspace packages matches itself
      dev-fleet has no packages directory: its set of workspace manifests is
      empty and known, not missing.
      Given the checkout has no "packages" directory
      When the fingerprint of the checkout is compared with itself
      Then every check has passed

    Scenario: A lockfile that changed no longer matches the manager's reference
      Given the fingerprint of the checkout was taken as the reference
      And "bun.lock" then changes to "changed"
      When the fingerprint of the checkout is compared with the reference
      Then the check "sync:bun.lock" has the status "fail"

    Scenario: Hashes that are missing never count as in sync
      When two fingerprints that name no commit and hold no hash are compared
      Then every check has failed

    Scenario: Uncommitted workspace manifests and mise lock sidecars are part of the fingerprint
      Given the fingerprint of the checkout was taken as the reference
      And "packages/example/package.json" then changes to '{"changed":true}'
      And ".mise/locks/extra.lock" then changes to "changed"
      When the fingerprint of the checkout is taken again
      Then its "workspace-manifests" hash differs from the reference
      And its "mise-sidecars" hash differs from the reference

  Rule: The receipt of the last frozen sync says whether dependencies are verified

    Scenario: Without a receipt, installed dependencies are unverified
      When the dependencies of the checkout are checked
      Then the check "dependencies" has the status "warn"

    Scenario: A receipt written for the current inputs verifies them
      Given a sync receipt was written for the inputs of the checkout
      When the dependencies of the checkout are checked
      Then the check "dependencies" has the status "pass"

    Scenario: A receipt is stale once an input changes
      Given a sync receipt was written for the inputs of the checkout
      And "mise.lock" then changes to "changed"
      When the dependencies of the checkout are checked
      Then the check "dependencies" has the status "fail"
