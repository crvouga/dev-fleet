Feature: Nothing on a worker listens beyond loopback and the tailnet unless the policy allows it
  worker:exposure is measured on the worker. It lists the listening TCP and
  UDP sockets and reads the fleet firewall. A socket bound to an address other
  than loopback or the tailnet fails, apart from what the declared policy
  allows: sshd and tailscaled (the firewall decides who reaches them), the
  system's own listeners and the ports the policy opens. The report names the
  port and the unit that owns it, never a process's arguments. A worker with
  no address outside the tailnet has nothing to expose.

  Background:
    Given a worker with these addresses:
      | interface  | address         |
      | lo         | 127.0.0.1       |
      | eth0       | 192.0.2.10      |
      | tailscale0 | 100.101.102.103 |
      | docker0    | 172.17.0.1      |
    And the worker is not a container
    And the fleet firewall is loaded
    And the exposure policy is:
      """
      {}
      """

  Rule: The default private setup passes

    Scenario: Only loopback, the tailnet and the allow-list listen
      Given these sockets listen:
        | protocol | address         | port  | unit                   |
        | tcp      | 0.0.0.0         | 22    | ssh.service            |
        | tcp      | ::              | 22    | ssh.service            |
        | udp      | 0.0.0.0         | 41641 | tailscaled.service     |
        | udp      | 0.0.0.0         | 68    | systemd-networkd.service |
        | tcp      | 127.0.0.1       | 3773  | t3code-desktop.service |
        | udp      | 127.0.0.53%lo   | 53    | systemd-resolved.service |
        | tcp      | 100.101.102.103 | 443   | tailscaled.service     |
        | tcp      | 172.17.0.1      | 8000  | docker.service         |
      When the exposure of the worker is checked
      Then the check passes
      And the summary of the check mentions "admits inbound traffic only over the tailnet"

  Rule: A fleet service beyond loopback and the tailnet fails, and is named

    Scenario: T3 on every address fails, naming its port and unit
      Given these sockets listen:
        | protocol | address | port | unit                   |
        | tcp      | 0.0.0.0 | 22   | ssh.service            |
        | tcp      | 0.0.0.0 | 3773 | t3code-desktop.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:3773 (t3code-desktop.service)"
      And the remedy of the check contains "Bind the named service to 127.0.0.1"

    Scenario: The T3 port fails even when its owner cannot be read
      Given these sockets listen:
        | protocol | address | port | unit |
        | tcp      | ::      | 3773 |      |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp [::]:3773 (unknown unit)"

    Scenario: A fleet service fails even where other listeners only warn
      Given the exposure policy is:
        """
        {"otherListeners": "warn"}
        """
      And these sockets listen:
        | protocol | address    | port  | unit                 |
        | tcp      | 192.0.2.10 | 45876 | beszel-agent.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check mentions "tcp 192.0.2.10:45876 (beszel-agent.service)"

    Scenario: The report names a unit and a port, never what the process was started with
      Given these sockets listen:
        | protocol | address | port | unit                   |
        | tcp      | 0.0.0.0 | 3773 | t3code-desktop.service |
      When the exposure of the worker is checked
      Then the checks do not contain "pid="
      And the checks do not contain "users:"
      And the checks do not contain "--token"

  Rule: An agent's development server is reported by the declared policy

    Scenario Outline: A development server on every address <verdict> when other listeners are "<policy>"
      Given the exposure policy is:
        """
        {"otherListeners": "<policy>"}
        """
      And these sockets listen:
        | protocol | address | port | unit                           |
        | tcp      | 0.0.0.0 | 22   | ssh.service                    |
        | tcp      | 0.0.0.0 | 5173 | t3code-agent-7f3a.scope        |
      When the exposure of the worker is checked
      Then the check <verdict>
      And the summary of the check is "WORKER_LISTENER_UNRESTRICTED tcp 0.0.0.0:5173 (t3code-agent-7f3a.scope)"

      Examples:
        | policy | verdict |
        | warn   | warns   |
        | fail   | fails   |

    Scenario: A port the policy opens may listen on every address
      Given the exposure policy is:
        """
        {"otherListeners": "fail", "publicPorts": [{"protocol": "tcp", "port": 5173}]}
        """
      And these sockets listen:
        | protocol | address | port | unit                    |
        | tcp      | 0.0.0.0 | 5173 | t3code-agent-7f3a.scope |
      When the exposure of the worker is checked
      Then the check passes

  Rule: The firewall that closes the rest is loaded, as declared

    Scenario: A worker without the fleet firewall fails
      Given the fleet firewall is not loaded
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_FIREWALL_INACTIVE"
      And the remedy of the check contains "devfleet fleet-sync"

    Scenario: SSH kept open beyond the tailnet without the opt-in fails
      fleet-sync keeps the public SSH port open while it cannot prove the
      manager reaches the worker over the tailnet: that must not pass quietly.
      Given the fleet firewall is loaded, keeping SSH open beyond the tailnet
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_PUBLIC_SSH_UNDECLARED"
      And the remedy of the check contains "Point the SSH alias of this worker at its tailnet name"

    Scenario: SSH kept open by the break-glass opt-in passes, and says so
      Given the exposure policy is:
        """
        {"publicSsh": true}
        """
      And the fleet firewall is loaded, keeping SSH open beyond the tailnet
      And these sockets listen:
        | protocol | address | port | unit        |
        | tcp      | 0.0.0.0 | 22   | ssh.service |
      When the exposure of the worker is checked
      Then the check passes
      And the summary of the check mentions "break-glass"

  Rule: A worker with no address outside the tailnet has nothing to expose

    Scenario: Only loopback, the tailnet and a container bridge have addresses
      Given a worker with these addresses:
        | interface  | address         |
        | lo         | 127.0.0.1       |
        | tailscale0 | 100.101.102.103 |
        | docker0    | 172.17.0.1      |
      When the exposure of the worker is checked
      Then the check is not applicable
      And the summary of the check mentions "no address outside the tailnet"
      And no command with the word "ss" was run

    Scenario: A worker that runs in a container leaves the network to its host
      Given the worker is a container
      When the exposure of the worker is checked
      Then the check is not applicable
      And the summary of the check mentions "container"

  Rule: What cannot be read fails, and says what

    Scenario: Sockets that sudo cannot list leave exposure unobserved
      Given the command "sudo -n ss -H -l -n -t -u -p" fails
      When the exposure of the worker is checked
      Then the check fails
      And the summary of the check is "WORKER_EXPOSURE_UNOBSERVED (sockets)"
