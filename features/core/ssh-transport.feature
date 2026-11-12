# ␊ stands for a line break.
Feature: The manager reaches a worker over SSH
  Every session is a new one that verifies the host key, asks nothing and
  forwards nothing. What goes to the worker is quoted so its shell evaluates
  none of it, and what comes back is a fleet document or a named failure:
  never a log.

  Background:
    Given this worker:
      | id        | dev-one             |
      | ssh       | dev-one             |
      | workspace | /home/dev/workspace |

  Rule: A session verifies the host, runs unattended and forwards nothing

    Scenario: The SSH command carries every safety option and ends with the SSH name of the worker
      When the SSH command for the worker is built
      Then it has each of these arguments:
        | BatchMode=yes             |
        | StrictHostKeyChecking=yes |
        | UpdateHostKeys=no         |
        | ClearAllForwardings=yes   |
        | ControlPath=none          |
        | -a                        |
        | -T                        |
      And its last argument is "dev-one"
      But it does not contain "StrictHostKeyChecking=no"

    Scenario: A session outlasts a minute of silence, so a short network blip does not end a long bootstrap
      When the SSH command for the worker is built
      Then it has each of these arguments:
        | ServerAliveInterval=15 |
        | ServerAliveCountMax=4  |

    Scenario: A connection that does not come up at once is tried again
      When the SSH command for the worker is built
      Then it has each of these arguments:
        | ConnectionAttempts=3 |
        | ConnectTimeout=10    |

    Scenario: A worker reached through the operator's own SSH alias is checked against the operator's own files
      When the SSH command for the worker is built
      Then it does not contain "UserKnownHostsFile"
      And it does not contain "HostKeyAlias"

  Rule: A worker without an alias is reached from declared data and a host key the fleet pins
    Nothing in the operator's ~/.ssh is needed or changed: the user, port and
    tailnet name come from fleet.json, the host key from the fleet state (or
    the worker's record), and the manager checks it against a known_hosts
    file of its own, rendered from them.

    Background:
      Given fleet.json declares this worker with no SSH alias:
        | id           | rented-one                   |
        | user         | dev                          |
        | port         | 2222                         |
        | tailnet name | rented-one.tail0a1b2c.ts.net |

    Scenario: The session takes the declared user, port and name, and the pinned key only
      Given the fleet state pins the host key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinnedKeyOfTheRentedWorker" for "rented-one"
      When the SSH command for the worker is built
      Then it has each of these arguments:
        | User=dev                         |
        | Port=2222                        |
        | HostKeyAlias=devfleet-rented-one |
        | StrictHostKeyChecking=yes        |
        | GlobalKnownHostsFile=/dev/null   |
        | BatchMode=yes                    |
      And its last argument is "rented-one.tail0a1b2c.ts.net"
      And the known_hosts file it names is not under "~/.ssh" and pins exactly:
        """
        devfleet-rented-one ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinnedKeyOfTheRentedWorker
        """

    Scenario: Without a pinned key nothing is trusted, so the first session is refused
      When the SSH command for the worker is built
      Then it has each of these arguments:
        | StrictHostKeyChecking=yes |
      And it does not contain "accept-new"
      And the known_hosts file it names is not under "~/.ssh" and pins exactly:
        """
        """

    Scenario: A machine that presents another key is refused, and the remedy pins the new one with one command
      Given an SSH session that failed, printing:
        """
        @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
        @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
        """
      When the failed session is classified
      Then the check "ssh:host-key" fails
      And the remedy of the check "ssh:host-key" mentions "devfleet fleet-node-replace --id ID --host-key"
      And the remedy of the check "ssh:host-key" mentions "hostKey in its worker record"

  Rule: A path is quoted so a POSIX shell evaluates none of it

    @posix
    Scenario: A quoted path reaches a shell exactly as it was written
      When a POSIX shell prints the path "/tmp/a'b $(printf evil); test", quoted
      Then it prints exactly "/tmp/a'b $(printf evil); test"

    @posix
    Scenario: The command sent to a worker enters its checkout by the quoted path
      Given this worker:
        | id        | dev-one                       |
        | ssh       | dev-one                       |
        | workspace | /tmp/a'b $(printf evil); test |
      When the command that probes the worker over SSH is built
      Then its last argument contains the workspace, quoted as:
        """
        '/tmp/a'\''b $(printf evil); test'
        """

  Rule: A failed session is named by its cause, and its output is not kept

    Scenario Outline: "<message>" is the failure "<check>"
      Given an SSH session that failed, printing:
        """
        <message>
        TOKEN=never-print-this
        """
      When the failed session is classified
      Then the check "<check>" fails
      And nothing reported contains "never-print-this"

      Examples:
        | message                                     | check            |
        | Host key verification failed                | ssh:host-key     |
        | REMOTE HOST IDENTIFICATION HAS CHANGED      | ssh:host-key     |
        | Could not resolve hostname internal         | ssh:dns          |
        | Permission denied (publickey)               | ssh:auth         |
        | agent refused operation                     | ssh:auth         |
        | Connection refused                          | ssh:network      |
        | Connection to dev-one closed by remote host | ssh:disconnected |
        | client_loop: send disconnect: Broken pipe   | ssh:disconnected |
        | Timeout, server dev-one not responding.     | ssh:disconnected |
        | bun: command not found                      | ssh:runtime      |

    Scenario Outline: A session that <ended> is the failure "<check>"
      Given an SSH session that <ended>
      When the failed session is classified
      Then the check "<check>" fails

      Examples:
        | ended                | check       |
        | ran out of time      | ssh:timeout |
        | could not be started | ssh:missing |

    Scenario: A Tailscale check-mode hold is named as one, even after the deadline
      The challenge address Tailscale prints is for a person at that machine
      and is not repeated.
      Given an SSH session that ran out of time, printing:
        """
        Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/PRIVATE_SENTINEL
        """
      When the failed session is classified
      Then the check "ssh:tailscale-check" fails
      And nothing reported contains "PRIVATE_SENTINEL"

  Rule: Only a fleet document is a sign of health

    Scenario Outline: A worker that answers <what> has not passed
      Given every command prints:
        """
        <reply>
        """
      When the worker is probed over SSH
      Then the check "ssh:protocol" fails
      And nothing reported contains "secret-token"

      Examples:
        | what                          | reply         |
        | a banner before its document  | banner␊{}     |
        | a document that says nothing  | {}            |
        | a document of another version | {"version":2} |
        | text that is not a document   | secret-token  |

  Rule: The probe a worker runs does not depend on the checkout of that worker

    Scenario: The probe is bundled into one program that imports nothing beside itself
      When the probe is bundled
      Then it is more than 1000 characters long
      And it does not contain "@pkgs/"
      And it imports no relative path
