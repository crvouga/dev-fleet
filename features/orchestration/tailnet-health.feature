Feature: The health of the tailnet accounts for every computer
  `fleet-status --tailnet` reports every computer Tailscale shows and every
  worker the manager has registered. A computer is probed over SSH only when
  exactly one registration maps to it and to nothing else; whatever cannot be
  probed is reported as such instead of being left out.

  Background:
    Given a checkout at commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And the probe source is "test-probe-source"
    And Tailscale discovery left out 1 mobile device and reported these checks:
      | id                  | status | summary |
      | tailscale:discovery | pass   | fixture |

  Scenario: The manager, an offline computer and one that is not registered are all reported
    Given the tailnet shows these computers:
      | name         | dns                         | address    | online | this manager |
      | manager      | manager.tailnet.ts.net      | 100.64.0.2 | yes    | yes          |
      | offline      | offline.tailnet.ts.net      | 100.64.0.2 | no     | no           |
      | unregistered | unregistered.tailnet.ts.net | 100.64.0.2 | yes    | no           |
    And the manager has no worker registered
    When the health of the tailnet is inspected
    Then the report covers, in order:
      | tailscale                   |
      | manager.tailnet.ts.net      |
      | offline.tailnet.ts.net      |
      | unregistered.tailnet.ts.net |
    And "offline.tailnet.ts.net" fails the check "tailscale:online"
    And "unregistered.tailnet.ts.net" fails the check "fleet:registration"
    And no SSH command was run
    And 1 tailscale command was run

  Scenario: A registered computer that is online is probed once, for the capabilities its registration requires
    Given the tailnet shows these computers:
      | name   | dns                   | address    | online | this manager |
      | remote | remote.tailnet.ts.net | 100.64.0.2 | yes    | no           |
    And the manager has these workers registered:
      | id      | ssh     | workspace           | required |
      | dev-one | dev-one | /home/dev/workspace |          |
    And the SSH alias "dev-one" resolves to "remote.tailnet.ts.net"
    And a probed worker answers with the snapshot of that checkout when no capability is required
    When the health of the tailnet is inspected
    Then 1 probe was sent over SSH
    And every SSH session was opened with "StrictHostKeyChecking=yes"
    And every SSH session was fed "test-probe-source"
    And every probe required exactly the capabilities ""
    And no probe required the capability "services"
    And the report of "remote.tailnet.ts.net" carries a snapshot

  Scenario: Two registrations for one computer are never probed, and a registration no computer matches fails by name
    Given the tailnet shows these computers:
      | name   | dns                   | address    | online | this manager |
      | remote | remote.tailnet.ts.net | 100.64.0.2 | yes    | no           |
    And the manager has these workers registered:
      | id        | ssh     | workspace           | required |
      | dev-one   | dev-one | /home/dev/workspace |          |
      | duplicate | dev-one | /home/dev/workspace |          |
      | hidden    | absent  | /home/dev/workspace |          |
    And the SSH alias "dev-one" resolves to "remote.tailnet.ts.net"
    And the SSH alias "absent" resolves to "hidden.tailnet.ts.net"
    When the health of the tailnet is inspected
    Then no probe was sent over SSH
    And "remote.tailnet.ts.net" fails the check "fleet:registration"
    And the first check of "hidden" is "tailscale:membership"

  Scenario: When the probe cannot be prepared, every computer is still reported and what went wrong is not
    Given the tailnet shows these computers:
      | name   | dns                   | address    | online | this manager |
      | remote | remote.tailnet.ts.net | 100.64.0.2 | yes    | no           |
      | other  | other.tailnet.ts.net  | 100.64.0.2 | yes    | no           |
    And the manager has these workers registered:
      | id      | ssh    | workspace           | required |
      | dev-one | remote | /home/dev/workspace |          |
      | other   | other  | /home/dev/workspace |          |
    And every SSH alias resolves to its own name in the tailnet "tailnet.ts.net"
    And preparing the probe source fails with the error "private-secret"
    When the health of the tailnet is inspected
    Then the probe source was prepared 1 time
    And "remote.tailnet.ts.net" fails the check "fleet:probe"
    And "other.tailnet.ts.net" fails the check "fleet:probe"
    And "private-secret" appears nowhere in what is reported

  Scenario: One SSH alias that matches two computers inspects neither
    Given the tailnet shows these computers:
      | name   | dns                   | address    | online | this manager |
      | remote | remote.tailnet.ts.net | 100.64.0.2 | yes    | no           |
      | other  | remote.second.ts.net  | 100.64.0.2 | yes    | no           |
    And the manager has these workers registered:
      | id      | ssh    | workspace           | required |
      | dev-one | remote | /home/dev/workspace |          |
    And the SSH alias "remote" resolves to "remote"
    When the health of the tailnet is inspected
    Then no probe was sent over SSH
    And 2 computers fail the check "fleet:registration"
