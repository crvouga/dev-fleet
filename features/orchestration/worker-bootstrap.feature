Feature: A worker is bootstrapped over SSH with one verified revision
  The manager opens host-key-verified SSH sessions to a worker: one asks
  whether the worker already holds the revision, the next runs the bootstrap
  script, fed the bundle only when the worker lacks it. What the worker reports
  back is kept as checks; nothing else it printed is.

  Rule: The manager sends only what the worker lacks, and believes only what the bootstrap proves

    Background:
      Given the manager has these workers registered:
        | id     | ssh    | workspace |
        | devbox | devbox | /unused   |
      And a bootstrap payload of:
        | revision | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa                         |
        | digest   | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
        | bundle   | ZmFrZS1idW5kbGU=                                                 |
      And the bootstrap script of the payload is:
        """
        #!/bin/sh
        # fixture
        """

    Scenario: A worker that already holds the revision is not sent the repository again
      Given the worker answers that it holds the revision
      And the bootstrap on the worker succeeds, printing:
        """
        {
          "version": 1,
          "checks": [
            { "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }
          ]
        }
        """
      When the worker is bootstrapped
      Then 2 SSH sessions were opened, and nothing else was run
      And every SSH session was opened with "StrictHostKeyChecking=yes"
      And every SSH session was opened with "-a"
      And the bootstrap ran in "cached" mode
      And the bootstrap was fed no bundle

    Scenario: A worker without the revision is sent the bundle, and the failure it reports is kept without what else it sent
      Given the worker answers that it does not hold the revision
      And the bootstrap on the worker fails, printing:
        """
        {
          "version": 1,
          "checks": [
            {
              "id": "bootstrap:prerequisites",
              "status": "fail",
              "summary": "SUDO_AUTHORIZATION_REQUIRED",
              "secret": "PRIVATE_SENTINEL"
            }
          ]
        }
        """
      When the worker is bootstrapped
      Then the bootstrap ran in "transfer" mode
      And the bootstrap was fed the bundle "ZmFrZS1idW5kbGU="
      And the first check says "SUDO_AUTHORIZATION_REQUIRED"
      And "PRIVATE_SENTINEL" appears nowhere in what is reported

    Scenario: The fleet configuration travels with the bootstrap, so it is written under the remote lock
      Two overlapping runs must never both write it: the bootstrap installs it
      only once it holds the lock, and no separate session writes it first.
      Given the payload carries the fleet configuration:
        """
        {"manager":{"id":"manager"}}
        """
      And the worker answers that it holds the revision
      And the bootstrap on the worker succeeds, printing:
        """
        {
          "version": 1,
          "checks": [
            { "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }
          ]
        }
        """
      When the worker is bootstrapped
      Then 2 SSH sessions were opened, and nothing else was run
      And the bootstrap was fed, before anything else, the fleet configuration:
        """
        {"manager":{"id":"manager"}}
        """
      And the bootstrap was fed no bundle

    Scenario Outline: The bootstrap tells the worker whether its T3 may restart while agent turns run (<request>)
      A worker's T3 restarts for a new release or policy only while it runs
      no agent turn, unless fleet-sync was given --restart-busy.
      Given the sync <request>
      And the worker answers that it holds the revision
      And the bootstrap on the worker succeeds, printing:
        """
        { "version": 1, "checks": [ { "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" } ] }
        """
      When the worker is bootstrapped
      Then the bootstrap passed "<mode>" as how the worker's T3 restarts

      Examples:
        | request                             | mode         |
        | keeps running agent turns           | keep-turns   |
        | restarts a busy T3 (--restart-busy) | restart-busy |

    Scenario: A worker held by another fleet operation reports the lock, and nothing else is claimed
      Given the worker answers that it does not hold the revision
      And the bootstrap on the worker fails, printing:
        """
        {
          "version": 1,
          "checks": [
            {
              "id": "bootstrap:lock",
              "status": "fail",
              "summary": "FLEET_REMOTE_LOCKED",
              "remedy": { "action": "Another fleet operation holds this machine." }
            }
          ]
        }
        """
      When the worker is bootstrapped
      Then the first check says "FLEET_REMOTE_LOCKED"
      And a check says "FLEET_REMOTE_LOCKED"

    Scenario: A worker held by an operation of the same revision is followed to its end, and its result is reported
      The run the manager lost (or another run of the same revision) is still
      converging the worker: the manager follows it instead of failing.
      Given the worker answers that it holds the revision
      And the bootstrap on the worker fails, printing:
        """
        { "version": 1, "checks": [{ "id": "bootstrap:lock", "status": "fail", "summary": "FLEET_REMOTE_LOCKED" }] }
        """
      And the worker says the operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is still running, in the phase "toolchain"
      And the worker says the operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is still running, in the phase "configuration"
      And the worker says the operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" has finished, with the result:
        """
        { "version": 1, "checks": [{ "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }] }
        """
      When the worker is bootstrapped
      Then 5 SSH sessions were opened, and nothing else was run
      And the first check is "bootstrap:attached"
      And a check says "Verified fixture"
      And while it followed, the manager showed:
        | Following the running operation (toolchain, 600 s)     |
        | Following the running operation (configuration, 615 s) |

    Scenario: A worker held by an operation of another revision reports the lock
      Given the worker answers that it holds the revision
      And the bootstrap on the worker fails, printing:
        """
        { "version": 1, "checks": [{ "id": "bootstrap:lock", "status": "fail", "summary": "FLEET_REMOTE_LOCKED" }] }
        """
      And the worker says the operation of the revision "cccccccccccccccccccccccccccccccccccccccc" is still running, in the phase "toolchain"
      When the worker is bootstrapped
      Then 3 SSH sessions were opened, and nothing else was run
      And the first check says "FLEET_REMOTE_LOCKED"

    Scenario: A lock held by something other than a running fleet operation is reported, not followed
      Given the worker answers that it holds the revision
      And the bootstrap on the worker fails, printing:
        """
        { "version": 1, "checks": [{ "id": "bootstrap:lock", "status": "fail", "summary": "FLEET_REMOTE_LOCKED" }] }
        """
      And the worker says something else holds its lock, and its last operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" has finished
      When the worker is bootstrapped
      Then 3 SSH sessions were opened, and nothing else was run
      And the first check says "FLEET_REMOTE_LOCKED"

    Scenario: A session lost mid-bootstrap is followed after a pause, and the operation's real result is reported
      Given the worker answers that it holds the revision
      And the bootstrap session is lost, printing "Connection to devbox closed by remote host."
      And the worker says the operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is still running, in the phase "toolchain"
      And the worker says the operation of the revision "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" has finished, with the result:
        """
        { "version": 1, "checks": [{ "id": "fixture:configuration", "status": "fail", "summary": "Real failure" }] }
        """
      When the worker is bootstrapped
      Then 4 SSH sessions were opened, and nothing else was run
      And the first check is "bootstrap:attached"
      And a check says "Real failure"
      And the manager paused for 25 seconds in all

    Scenario: A session lost before the worker started anything is opened again
      Given the worker answers that it does not hold the revision
      And the bootstrap session cannot be opened, printing "ssh: connect to host devbox port 22: Network is unreachable"
      And the worker says no operation runs on it
      And the bootstrap on the worker succeeds, printing:
        """
        { "version": 1, "checks": [{ "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }] }
        """
      When the worker is bootstrapped
      Then 4 SSH sessions were opened, and nothing else was run
      And the first check says "Verified fixture"
      And the manager paused for 10 seconds in all

    Scenario: A connection that cannot be opened is tried three times over thirty seconds, then named
      Given the session cannot be opened, printing "ssh: connect to host devbox port 22: Connection refused"
      And the session cannot be opened, printing "ssh: connect to host devbox port 22: Connection refused"
      And the session cannot be opened, printing "ssh: connect to host devbox port 22: Connection refused"
      When the worker is bootstrapped
      Then 3 SSH sessions were opened, and nothing else was run
      And the first check is "ssh:network"
      And the manager paused for 30 seconds in all

    Scenario: A connection that comes back on the second attempt goes on with the bootstrap
      Given the session cannot be opened, printing "ssh: connect to host devbox port 22: Connection refused"
      And the worker answers that it holds the revision
      And the bootstrap on the worker succeeds, printing:
        """
        { "version": 1, "checks": [{ "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }] }
        """
      When the worker is bootstrapped
      Then 3 SSH sessions were opened, and nothing else was run
      And the first check says "Verified fixture"
      And the manager paused for 10 seconds in all

    Scenario: An unknown host key stops the bootstrap before anything is sent
      Given every SSH session fails with the error output "Host key verification failed. PRIVATE_SENTINEL"
      When the worker is bootstrapped
      Then 1 SSH session was opened, and nothing else was run
      And no SSH session was fed anything
      And the first check is "ssh:host-key"
      And "PRIVATE_SENTINEL" appears nowhere in what is reported

    Scenario: Checks that passed cannot hide a bootstrap that exited with a failure
      Given the worker answers that it holds the revision
      And the bootstrap on the worker fails, printing:
        """
        {
          "version": 1,
          "checks": [
            { "id": "fixture:configuration", "status": "pass", "summary": "Verified fixture" }
          ]
        }
        """
      When the worker is bootstrapped
      Then a check says "REMOTE_BOOTSTRAP_EXIT_FAILED"

  Rule: The bundle holds the approved commit and none of its history

    Scenario: A checkout that is shallow at the commit accepts a bundle that carries only that commit
      Workers run one revision and never need history, so what an earlier
      commit held does not travel. The new checkout is prepared the way
      fleet-remote-bootstrap.sh prepares it on the worker: marked shallow at
      the commit before it fetches. Git runs for real here, in a temporary
      directory, and nothing is fetched from the network.
      Given a source checkout whose origin is the source repository of the fleet
      And it holds these scripts, each of the one line "#!/bin/sh":
        | bootstrap/fleet-remote-bootstrap.sh |
        | ansible/ubuntu/authorize-sudo.sh    |
      And its first commit adds "old.txt" holding "history that must not travel"
      And its second commit removes "old.txt" and adds "new.txt" holding "current"
      When the second commit is bundled for a worker and fetched into a new checkout that is shallow at it
      Then the payload names the second commit
      And the new checkout fetched the commit from the bundle
      And the new checkout checked the commit out
      And "new.txt" in the new checkout holds "current"
      And the new checkout has no uncommitted change
      And the new checkout has 1 commit of history
      And the new checkout passes "git fsck --no-dangling"
      And the bundle nowhere contains "history that must not travel"
