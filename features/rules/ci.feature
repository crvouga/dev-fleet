Feature: Every pull request is checked the way machines run

  Scenario: A service a check starts is pinned by digest
    When the service images of the "CI" workflow are read
    Then there is at least one
    And each is pinned by tag and SHA-256 digest

  Scenario: The fleet state check runs on every pull request and cannot skip
    Then the "CI" workflow runs on "pull_request"
    And its "state" job has no condition
    And its "state" job sets "DEVFLEET_TEST_LITESTREAM" to "required"
    And its "state" job points "DEVFLEET_TEST_S3" at a local S3 service

  Scenario Outline: The <job> check runs on every pull request
    Then the "CI" workflow runs on "pull_request"
    And its "<job>" job has no condition

    Examples:
      | job       |
      | check     |
      | state     |
      | fresh-box |
      | workflows |

  Scenario: The fresh worker check covers both architectures a worker may have
    Then the "CI" workflow runs on "pull_request"
    And its "fresh-box" job runs once for each of:
      | architecture | runner           |
      | amd64        | ubuntu-latest    |
      | arm64        | ubuntu-24.04-arm |

  Scenario: A fresh worker is bootstrapped over SSH on every pull request
    Then the "CI" workflow runs on "pull_request"
    And its "fresh-box" job has no condition
    And its "fresh-box" job runs "bun test features/fresh-box"
    And its "fresh-box" job sets "DEVFLEET_TEST_FRESH_BOX" to "required"

  Scenario: A release stamps the commit it is published from into the package
    fleet-sync run from the package converges every machine to the commit the
    package names, so a release that does not name one cannot move a fleet.
    When the "Publish to npm" step of the "Release" workflow is read
    Then it runs "npm pkg set gitHead=\"$(git rev-parse HEAD)\"" before "npm publish"
