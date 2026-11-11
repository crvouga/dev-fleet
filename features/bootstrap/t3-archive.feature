Feature: An installed T3 is verified against its pinned archive
  A release is built on another machine, so the numeric owner recorded in
  the archive is never the worker's user: the builder's identity is not the
  installation's. Content, modes and links must still match.

  @linux
  Scenario Outline: An installation with <drift> <verdict> the archive
    Given a release archive, built by another user, that holds "t3" with the content "pinned binary" and the mode 755
    And an installation that holds "t3" <installed>
    When the installation is verified against the archive
    Then the installation <verdict> the archive

    Examples:
      | drift                       | installed                                                       | verdict        |
      | only another owner          | with the content "pinned binary" and the mode 755               | matches        |
      | a changed mode              | with the content "pinned binary" and the mode 644               | does not match |
      | changed content             | with the content "edited binary" and the mode 755               | does not match |
      | a link in place of the file | as a link to a file outside it with the content "pinned binary" | does not match |
