Feature: The version a release publishes
  The newest vX.Y.Z tag is the last release. The commits since then pick the
  bump, in the style of Conventional Commits, and every merge after the tag
  releases the next version.

  Rule: The commits since the last release pick the bump

    Scenario Outline: <rule>
      When these commits are released: <commits>
      Then the bump is "<bump>"

      Examples:
        | rule                                                           | commits                                                | bump  |
        | Anything that is not a feature or a breaking change is a patch | "fix: a", "chore: b", "Merge pull request #1 from x/y" | patch |
        | Documentation alone is a patch                                 | "docs: a"                                              | patch |
        | A feature is a minor bump                                      | "fix: a", "feat(cli): b"                               | minor |
        | A breaking feature is a major bump                             | "feat!: drop x"                                        | major |
        | A breaking change of any other kind is a major bump            | "refactor(cli)!: rename"                               | major |
        | A subject that only mentions a breaking change is a patch      | "fix: mention feat!: in passing"                       | patch |

    Scenario: A breaking change named in a commit's footer is a major bump
      When a commit with this message is released:
        """
        fix: a

        BREAKING CHANGE: b
        """
      Then the bump is "major"

  Rule: Bumps follow semver, with breaking changes staying minor below 1.0

    Scenario Outline: A <bump> bump of <tag> is <version>
      When the release "<tag>" is given a "<bump>" bump
      Then the next version is "<version>"

      Examples:
        | tag    | bump  | version |
        | v0.1.0 | patch | 0.1.1   |
        | v0.1.3 | minor | 0.2.0   |
        | v0.1.3 | major | 0.2.0   |
        | v1.2.3 | major | 2.0.0   |
        | v1.2.3 | minor | 1.3.0   |

    Scenario: A tag that is not a release cannot be bumped
      When the release "v1.2" is given a "patch" bump
      Then it is refused

  Rule: The newest release tag wins and other v* tags are ignored

    Scenario Outline: Of <tags>, the last release is <last>
      Given git lists the tags <tags>, newest first
      When the last release is looked up
      Then the last release is "<last>"

      Examples:
        | tags                          | last    |
        | "v1.10.0", "v1.9.0", "v0.1.0" | v1.10.0 |
        | "v2-beta", "v1.0.0"           | v1.0.0  |

    Scenario: Without a tag there is no last release
      Given git lists no tags
      When the last release is looked up
      Then there is no last release

  Rule: Every merge after the last release releases the next version

    Scenario: No tag and nothing on npm means the one-time npm setup has not run
      The Release workflow fails then: a skipped release is not a success.
      Given git lists no tags
      And the commits since the last tag are "feat: a"
      When the release is decided
      Then nothing is released
      And the run fails, because publishing was never set up
      And the reason given mentions "bootstrap"

    Scenario: Without a tag, the newest version on npm is the last release
      The seed version was published by hand and npm recorded no commit for
      it, so nothing could be tagged. Every commit up to HEAD then counts.
      Given git lists no tags
      And npm holds the versions "0.0.0-stage", "0.1.0"
      And the commits since the last tag are "fix: a", "feat: b"
      When the release is decided
      Then the version "0.2.0" is released, after "v0.1.0"

    Scenario Outline: Of the versions <versions> on npm, the newest release is <newest>
      Given git lists no tags
      And npm holds the versions <versions>
      And the commits since the last tag are "fix: a"
      When the release is decided
      Then the version "<next>" is released, after "v<newest>"

      Examples:
        | versions                      | newest | next   |
        | "0.9.0", "0.10.0", "0.1.0"    | 0.10.0 | 0.10.1 |
        | "1.0.0-rc.1", "0.3.0"         | 0.3.0  | 0.3.1  |

    Scenario: A commit that is already in a release is not released again
      Given git lists the tags "v0.2.0", newest first
      And HEAD is already in the last release
      And the commits since the last tag are "feat: a"
      When the release is decided
      Then nothing is released, because "HEAD is already in v0.2.0."

    Scenario: A release that pushed its tag and failed before its GitHub Release is finished by a full re-run
      A re-run of every job finds HEAD tagged. The version is released again:
      the publish skips what npm already holds from this commit, and the
      GitHub Release is created.
      Given git lists the tags "v0.3.0", "v0.2.0", newest first
      And HEAD carries the tag "v0.3.0", without its GitHub Release
      When the release is decided
      Then the version "0.3.0" is released, after "v0.2.0"

    Scenario: A finished release is not released again
      Given git lists the tags "v0.3.0", "v0.2.0", newest first
      And HEAD carries the tag "v0.3.0", with its GitHub Release
      When the release is decided
      Then nothing is released, because "HEAD is already in v0.3.0."

    Scenario: No commits since the tag means nothing to release
      Given git lists the tags "v0.2.0", newest first
      When the release is decided
      Then nothing is released

    Scenario: Every merge after the tag releases the next version
      Given git lists the tags "v0.2.0", newest first
      And the commits since the last tag are "Merge pull request #7 from x/y", "feat: add a flag"
      When the release is decided
      Then the version "0.3.0" is released, after "v0.2.0"
