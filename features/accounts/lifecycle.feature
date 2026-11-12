Feature: Adding, signing in again and removing one provider account
  "devfleet fleet-accounts" lists the roster on the manager. "--add PROVIDER",
  "--relogin PROVIDER INDEX" and "--remove PROVIDER INDEX" change one account
  on the CLI proxy, where a sign-in writes into a staging directory and only
  a complete credential is moved in (cliproxy/tests/test_accounts.py). Every
  change is followed by the fast account propagation to every node and a
  fresh roster.

  Background:
    Given the proxy reports these accounts:
      | provider | index | label         | state       | until |
      | claude   | 1     | a@example.com | usable      |       |
      | claude   | 2     | b@example.com | needs-login |       |

  Scenario: The roster lists every account with its state
    When the operator runs fleet-accounts with ""
    Then it exits with 0
    And it lists claude account 2 as "needs-login"
    And the proxy was asked for nothing but its roster

  Scenario Outline: <change> runs one proxy command, then propagates the accounts
    When the operator runs fleet-accounts with "<arguments>"
    Then the proxy ran "<proxy command>"
    And the accounts were propagated once

    Examples:
      | change                | arguments          | proxy command         |
      | Adding an account     | --add codex        | add-account codex     |
      | Signing one in again  | --relogin claude 2 | relogin claude 2      |
      | Removing one account  | --remove claude 1  | remove-account claude 1 |

  Scenario: A sign-in that does not complete propagates nothing
    Given the proxy's sign-in is interrupted
    When the operator runs fleet-accounts with "--add claude"
    Then it exits with 1
    And the accounts were not propagated

  Scenario Outline: A change that does not name its account is refused: <arguments>
    When the operator runs fleet-accounts with "<arguments>"
    Then it is refused saying "<message>"
    And the proxy ran nothing

    Examples:
      | arguments             | message                   |
      | --relogin claude      | needs the account's index |
      | --remove              | needs a provider          |
      | --add claude --remove | Choose one of             |
