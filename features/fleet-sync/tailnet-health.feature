Feature: The tailnet is discovered and its health audited without trusting the roster
  Discovery only reads what Tailscale reports. Health keeps every computer it
  saw, online or not, registered or not, and never narrows what it checks.

  Background:
    Given an empty workspace, and a roster file in it that does not exist
    And the tailnet shows these computers:
      | id     | name   | dns                   | os    | address    | online | this computer |
      | self   | self   | self.tailnet.ts.net   | linux | 100.64.0.1 | yes    | yes           |
      | remote | remote | remote.tailnet.ts.net | macOS | 100.64.0.2 | no     | no            |
    And bundling the source would fail the scenario

  Scenario: Discovery needs neither a roster nor a healthy workspace, and never attempts SSH or a login
    When the fleet is asked to "discover"
    Then exactly these commands were run:
      | tailscale status --json |
    And the command exits with 0
    And the report has:
      | ok                 | true |
      | coverage.computers | 2    |

  Scenario: Health keeps offline and unregistered computers and cannot certify partial coverage
    Given every other command succeeds, and Git names the commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    When the fleet is asked to "health"
    Then the command exits with 1
    And the report has:
      | ok                 | false |
      | coverage.computers | 2     |
      | coverage.verified  | false |
    And the report of the computer "remote.tailnet.ts.net" has at least these checks:
      | check              | status |
      | tailscale:online   | fail   |
      | fleet:registration | fail   |

  Scenario Outline: Health refuses "<option>", which would silently narrow its checks
    When the fleet is asked to "health <option>"
    Then the request is refused

    Examples:
      | option         |
      | --local        |
      | --all          |
      | --node one     |
      | --require none |

  Scenario: Health refuses a malformed roster
    Given the roster file holds:
      """
      {broken
      """
    When the fleet is asked to "health"
    Then the request is refused
