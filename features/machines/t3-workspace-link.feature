Feature: T3 references the applied revision through one stable link
  Fleet revisions live in "revisions/<commit>" on a worker and in
  "manager-runs/<commit>" on the manager. T3's provider settings name the link
  "current" beside that directory, so the settings (and the restart a changed
  policy needs) change only when they really change, not on every new commit,
  and never name a checkout that is later pruned.

  Scenario: A fleet revision is referenced through the link "current"
    Given a fleet directory that holds the revisions "aaa" and "bbb"
    When the revision "aaa" becomes the one T3 references
    Then T3 references "current" in the fleet directory
    And "current" links to "revisions/aaa"

  Scenario: The next revision moves the link, not what T3 references
    Given a fleet directory that holds the revisions "aaa" and "bbb"
    And the revision "aaa" is the one T3 references
    When the revision "bbb" becomes the one T3 references
    Then T3 references the same path as before
    And "current" links to "revisions/bbb"
    And "current" resolves to the revision "bbb"

  Scenario: Any other checkout is referenced as it is
    When the checkout "/home/me/personal" becomes the one T3 references
    Then T3 references "/home/me/personal"
