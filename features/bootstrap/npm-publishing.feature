Feature: The one-time npm setup for publishing
  npm can publish new versions of a package through OIDC but cannot create a
  package that does not exist yet. So once, with a person's own npm login:
  publish the seed version, make the Release workflow the package's trusted
  publisher, and tag the commit that was published. Every step measures first
  and skips what is already done, so the setup can be run again after any
  interruption.

  Background:
    Given the package "@scope/pkg" of the repository "owner/repo", checked out at "/repo"
    And npm 11.20.0 is installed
    And a clean checkout of main, at the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Rule: The setup does what is not done yet, in order

    Scenario: A fresh setup signs in, publishes the seed, trusts the workflow and tags the published commit
      When the setup is run with "--yes --skip-check"
      Then it exits with 0
      And it runs, in order:
        | npm login --auth-type=web                                                              |
        | publish the seed version                                                               |
        | npm trust github @scope/pkg --repo owner/repo --file release.yml --allow-publish --yes |
        | git tag v0.1.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa                                |
        | git push origin refs/tags/v0.1.0                                                       |

    Scenario: Running it again after it finished changes nothing
      Given "someone" is signed in to npm
      And the seed version is published
      And the Release workflow is trusted to publish the package
      And the seed tag exists here and on the remote
      When the setup is run with "--yes --skip-check"
      Then it exits with 0
      And it runs nothing
      And the last thing it says contains "Nothing to do"

    Scenario: A seed npm recorded no commit for is not tagged
      There is no commit to tag. The Release workflow counts from the newest
      version on npm instead, so the setup is finished.
      Given "someone" is signed in to npm
      And the seed version is published, and npm recorded no commit for it
      And the Release workflow is trusted to publish the package
      When the setup is run with "--yes --skip-check"
      Then it exits with 0
      And it runs nothing
      And the last thing it says contains "Nothing to do"

    Scenario: An interrupted run resumes at the first step that is not done
      Given "someone" is signed in to npm
      And the seed version is published
      When the setup is run with "--yes --skip-check"
      Then it exits with 0
      And the first thing it runs starts with "npm trust github"
      And it does not publish the seed version

  Rule: The seed is published from the commit that is main, and only when asked

    Scenario: It will not publish from uncommitted work
      Given "someone" is signed in to npm
      And the working tree has uncommitted changes
      When the setup is run with "--yes --skip-check"
      Then it exits with 1
      And it runs nothing

    Scenario: It will not publish from a commit that is not main
      Given "someone" is signed in to npm
      And the checkout is at the commit "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      When the setup is run with "--yes --skip-check"
      Then it exits with 1
      And it runs nothing

    Scenario: Declining the confirmation runs nothing
      Given the person answers no when asked to confirm
      When the setup is run with "--skip-check"
      Then it exits with 130
      And it runs nothing

  Rule: An old npm is refused before anything runs
    Trusting a workflow needs "npm trust", which npm has from 11.10.

    Scenario Outline: npm <version> is <verdict>
      When npm reports the version "<version>"
      Then npm is <verdict> to trust a workflow

      Examples:
        | version | verdict       |
        | 11.9.9  | too old       |
        | 11.10.0 | recent enough |
        | 12.0.0  | recent enough |

    Scenario: A missing npm is too old
      When npm reports no version
      Then npm is too old to trust a workflow

  Rule: The registry being down is not "unpublished"

    Scenario: A registry that cannot be reached stops the setup
      Given no command succeeds, and every npm command says "ECONNREFUSED"
      When what is already done is measured
      Then it is refused with "npm registry"

    Scenario: A package the registry does not know is planned from the first step
      When the setup is planned
      Then the plan has these steps, in order:
        | login   |
        | publish |
        | trust   |
        | tag     |
