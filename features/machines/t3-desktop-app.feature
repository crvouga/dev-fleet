Feature: A worker runs one T3: the pinned desktop app
  The desktop app starts with the worker's auto-login graphical session. A
  playbook installs it, retires the former headless server and starts the app.
  Around the play, a launcher of another release is refused beforehand and the
  result is measured afterwards: nothing here starts, stops or pairs anything.

  Background:
    Given the pinned T3 release is "0.1.7", installed at "/managed/t3"

  Scenario: A running desktop app is checked without a restart or pairing
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | succeeds         |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
    When the worker's T3 desktop app is converged
    Then the check passes
    And no command with any of these words was run:
      | start   |
      | restart |
      | stop    |
      | pair    |

  Scenario: A launcher of another release is kept, not replaced
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.8 |
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_EXECUTABLE_OWNER_CONFLICT"
    And 1 command ran

  Scenario: A launcher of another release stops policy staging and installation
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.8 |
    When the worker's T3 desktop app is converged
    Then the policy was not staged
    And the desktop app was not installed

  Scenario: A failed installation is reported and nothing is started
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.7 |
    And installing the desktop app fails
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_INSTALL_FAILED"
    And no command with the word "start" was run

  Scenario: An app the play left stopped is reported, not started from here
    The play owns every change. This only measures: it never runs a systemctl
    verb that changes a unit, not even for the former headless server.
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | fails            |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
      | systemctl --user is-active t3code.service          | fails            |
      | systemctl --user is-enabled t3code.service         | succeeds         |
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_STOPPED"
    And no command with any of these words was run:
      | start        |
      | stop         |
      | disable      |
      | restart      |
      | reset-failed |

  Scenario: An app that cannot start without a graphical session is reported
    Given these commands answer:
      | command                                            | answer           |
      | t3 --version                                       | prints t3 v0.1.7 |
      | systemctl --user is-active t3code-desktop.service  | fails            |
      | systemctl --user is-enabled t3code-desktop.service | succeeds         |
      | systemctl --user is-active t3code.service          | fails            |
      | systemctl --user is-enabled t3code.service         | fails            |
    When the worker's T3 desktop app is converged
    Then the summary of the check is "T3_DESKTOP_STOPPED"
