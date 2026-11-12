Feature: A headless worker runs the pinned T3 server, with no display
  A server image has no display manager, no desktop session, no GPU and
  nobody to log in. A worker whose session is "headless" (fleet.json
  features.session) runs the pinned T3 server instead of the desktop app: the
  native archive the same release ships beside the desktop package, which the
  toolchain installs on every worker. `t3 serve` runs the server the desktop
  app embeds, with no browser. It is a lingering user service, so it starts
  at boot with nobody logged in, and it listens where the desktop app does:
  the private route, the policy, the provider instances, the recovery timer
  and the checks are the same for both session types. ~/.t3 is kept when a
  worker changes type. As for the desktop app, a playbook changes the machine
  and this only measures the result.

  Background:
    Given the pinned T3 release is "0.1.8", installed at "/managed/t3"

  Scenario: A running server is checked without a restart or pairing
    Given these commands answer:
      | command                                             | answer           |
      | t3 --version                                        | prints t3 v0.1.8 |
      | systemctl --user is-active t3code-headless.service  | succeeds         |
      | systemctl --user is-enabled t3code-headless.service | succeeds         |
    When the headless worker's T3 server is converged
    Then the check passes
    And the summary of the check is "Pinned T3 server is enabled as a lingering user service and running, with no display. Private routing, policy and pairing remain separate checks."
    And no command with any of these words was run:
      | start                  |
      | restart                |
      | stop                   |
      | pair                   |
      | t3code-desktop.service |

  Scenario: A server the play left stopped is reported, not started from here
    Given these commands answer:
      | command                                             | answer           |
      | t3 --version                                        | prints t3 v0.1.8 |
      | systemctl --user is-active t3code-headless.service  | fails            |
      | systemctl --user is-enabled t3code-headless.service | succeeds         |
    When the headless worker's T3 server is converged
    Then the summary of the check is "T3_SERVER_STOPPED"
    And the remedy of the check contains "needs no login"
    And no command with the word "start" was run

  Scenario: A failed installation is reported and nothing is started
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.8 |
    And installing the T3 server fails
    When the headless worker's T3 server is converged
    Then the summary of the check is "T3_SERVER_INSTALL_FAILED"
    And no command with the word "start" was run

  Scenario: A launcher of another release stops the installation, as on a desktop worker
    Given these commands answer:
      | command      | answer           |
      | t3 --version | prints t3 v0.1.9 |
    When the headless worker's T3 server is converged
    Then the summary of the check is "T3_EXECUTABLE_OWNER_CONFLICT"
    And the policy was not staged

  Scenario: The installed release is the versioned server the unit runs
    Given these commands answer:
      | command                                                                     | answer                                                                                                                                         |
      | curl --fail --silent --max-time 10 http://127.0.0.1:3773/.well-known/t3/environment | prints {"environmentId":"e","serverVersion":"0.1.8-nightly.20261106.4262"}                                                       |
      | systemctl --user show --property=ExecStart --value t3code-headless.service  | prints { path=/home/dev/.local/share/personal/tools/t3-0.1.8-nightly.20261106.4262-linux-x64/t3 ; argv[]=/home/dev/.local/share/personal/tools/t3-0.1.8-nightly.20261106.4262-linux-x64/t3 serve ; } |
    When the release of the T3 of a headless worker is checked
    Then the check passes
    And the summary of the check is "The running T3 server is the installed release 0.1.8-nightly.20261106.4262."

  Scenario: The server's unit needs no display, no graphical session and no login
    Then "ansible/ubuntu/t3-headless.yml" declares the unit "t3code-headless.service" with these lines:
      | ExecStart="{{ t3_server_path }}" serve --mode web --host 127.0.0.1 --port 3773 --base-dir %h/.t3 --no-browser |
      | Environment=T3CODE_HOME=%h/.t3                                                                                 |
      | Restart=always                                                                                                 |
      | WantedBy=default.target                                                                                        |
    And "ansible/ubuntu/t3-headless.yml" declares the unit "t3code-headless.service" with no line containing "graphical-session"
    And "ansible/ubuntu/t3-headless.yml" declares the unit "t3code-headless.service" with no line containing "ozone"

  Scenario: The desktop app's unit is unchanged
    Then "ansible/ubuntu/t3-desktop.yml" declares the unit "t3code-desktop.service" with these lines:
      | PartOf=graphical-session.target                            |
      | ExecStart="{{ t3_desktop_dir }}/t3code" --ozone-platform=x11 |
      | WantedBy=graphical-session.target                          |
