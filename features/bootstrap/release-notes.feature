Feature: The notes of a release
  The Release workflow writes the notes of each GitHub Release from the
  Conventional Commits since the last release. Whoever installs it reads
  first what restarts the workers.

  Scenario: Commits are grouped by kind, features first
    When the notes are written for these commits:
      """
      fix(cli): a refused flag says why
      ---
      feat: fleet-sync --rollback
      ---
      docs: rollback is documented once
      ---
      Merge pull request #3 from someone/branch
      """
    Then the notes are:
      """
      ## Features

      - fleet-sync --rollback

      ## Fixes

      - **cli:** a refused flag says why

      ## Other changes

      - rollback is documented once
      """

  Scenario: A change that restarts the workers is listed first, with its reason
    Restarting T3 on a worker ends the agent turns running there.
    When the notes are written for these commits:
      """
      fix: keep the agent alive
      ---
      feat(t3): the next nightly

      Worker-Restart: the T3 desktop app is replaced
      """
    Then the notes are:
      """
      ## Requires a worker restart (ends agent turns)

      - **t3:** the next nightly (the T3 desktop app is replaced)

      ## Features

      - **t3:** the next nightly

      ## Fixes

      - keep the agent alive
      """

  Scenario: A breaking change is listed under its own heading too
    When the notes are written for these commits:
      """
      refactor(cli)!: flags replace the old aliases
      ---
      fix: a

      BREAKING CHANGE: the report moved
      """
    Then the notes are:
      """
      ## Breaking changes

      - **cli:** flags replace the old aliases
      - a: the report moved

      ## Fixes

      - a

      ## Other changes

      - **cli:** flags replace the old aliases
      """
