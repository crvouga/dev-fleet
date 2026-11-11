# ␊ stands for a line break.
Feature: The manager finds the fleet's computers on its tailnet
  The manager asks its own Tailscale which machines it can see. What comes
  back is another program's document: it is checked field by field before any
  of it becomes a host name the manager would connect to, and a discovery
  that may be incomplete never passes.

  Background:
    Given Tailscale is running and lists these machines:
      | machine      | ID      | HostName | DNSName                 | OS      | Online | TailscaleIPs |
      | this machine | manager | manager  | manager.tailnet.ts.net. | macOS   | true   | 100.64.0.1   |
      | peer         | offline | offline  | offline.tailnet.ts.net. | linux   | false  | 100.64.0.1   |
      | peer         | phone   | phone    | phone.tailnet.ts.net.   | iOS     | true   | 100.64.0.1   |
      | peer         | android | android  | android.tailnet.ts.net. | android | true   | 100.64.0.1   |
    And Tailscale reports no health problem

  Rule: Every computer is listed, this one and the offline ones too; only phones are left out

    Scenario: Discovery lists the manager and an offline computer, and leaves out two phones
      When the manager reads the status of Tailscale
      Then these computers are found, in this order:
        | id      | online |
        | manager | true   |
        | offline | false  |
      And 2 mobile devices are left out
      And the check "tailscale:discovery" passes

    Scenario: An operating system the manager has never heard of is still a computer
      Only the operating systems known to be mobile are left out.
      Given Tailscale reports the "OS" of the peer "offline" as "new-unknown-os"
      When the manager reads the status of Tailscale
      Then 2 computers are found

  Rule: A discovery that may be incomplete never passes, and repeats nothing Tailscale printed

    Scenario: A health problem fails discovery
      Given Tailscale reports the health problem "private daemon diagnostic"
      When the manager reads the status of Tailscale
      Then the check "tailscale:discovery" fails
      And nothing reported contains "private daemon diagnostic"

    Scenario: A Tailscale that is not signed in fails discovery
      Given the status of Tailscale is:
        """
        { "BackendState": "NeedsLogin" }
        """
      When the manager reads the status of Tailscale
      Then the check "tailscale:discovery" fails

    Scenario Outline: Discovery fails when Tailscale <situation>
      Given <answer>
      When the manager asks Tailscale for its status
      Then the check "tailscale:discovery" fails
      And nothing reported contains "private-token"

      Examples:
        | situation                         | answer                                                                     |
        | cannot be asked                   | the command "tailscale status --json" fails with the error "private-token" |
        | prints something that is not JSON | the command "tailscale status --json" prints "{"                           |
        | does not describe this machine    | the command "tailscale status --json" prints '{"BackendState":"Running"}'  |

  Rule: What Tailscale says of a machine is checked before it is used

    Scenario Outline: This machine described with <field> <value> is refused
      Given Tailscale reports the "<field>" of this machine as <value>
      When the manager reads the status of Tailscale
      Then it is refused

      Examples:
        | field        | value                   |
        | DNSName      | "-oProxyCommand=secret" |
        | TailscaleIPs | ["localhost;command"]   |
        | Online       | "yes"                   |

    Scenario: Two machines with one ID are refused
      Given Tailscale reports the "ID" of the peer "offline" as "manager"
      When the manager reads the status of Tailscale
      Then it is refused

    Scenario: More than 1024 peers are refused
      Given Tailscale lists 1025 peers numbered from 0, where # is the number:
        | ID | HostName | DNSName           | OS    | Online | TailscaleIPs |
        | #  | #        | #.tailnet.ts.net. | macOS | true   | 100.64.0.1   |
      When the manager reads the status of Tailscale
      Then it is refused

  Rule: A worker is matched to a computer by its exact name or address, never by the start of one

    Scenario Outline: The host name "<host>" <verdict> the computer "offline"
      When the manager reads the status of Tailscale
      Then the host name "<host>" <verdict> the computer "offline"

      Examples:
        | host                    | verdict       |
        | offline                 | names         |
        | OFFLINE.tailnet.ts.net. | names         |
        | offline-other           | does not name |

    Scenario: Workers are matched by the host name their SSH name resolves to
      SSH is only asked what a name resolves to, with local commands off.
      Given a roster of these workers:
        | id        | ssh     | workspace           | required |
        | dev-one   | alias   | /home/dev/workspace | nothing  |
        | duplicate | another | /home/dev/workspace | nothing  |
      And every command prints "hostname offline.tailnet.ts.net␊"
      When the workers of the roster are matched to the computer "offline"
      Then the computer "offline" is matched by 2 workers
      And every command was run with the argument "PermitLocalCommand=no"
