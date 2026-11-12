Feature: The manager tries the worker's public address from outside the tailnet
  worker:public-reachability runs on the manager during fleet-status
  --workers. When Tailscale knows a public address for a worker, the manager
  tries its SSH, T3 and monitoring ports there, and fails if any accepts a
  connection. It is optional: the manager may share the worker's network, so
  it never blocks readiness. It names the service and port, never the address.

  Background:
    Given the exposure policy is:
      """
      {}
      """

  Scenario: The default private setup accepts nothing on the public address
    Given Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "203.0.113.20:41641, 192.168.1.20:41641"
    And no port accepts a connection
    When the public reachability of "worker-one" is checked
    Then the check passes
    And the summary of the check mentions "SSH (tcp 22), T3 (tcp 3773), the monitoring agent (tcp 45876)"
    And only these connections were tried:
      | 203.0.113.20:22    |
      | 203.0.113.20:3773  |
      | 203.0.113.20:45876 |
    And the check does not block readiness

  Scenario: A public SSH port that accepts fails, without the address
    Given Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "203.0.113.20:41641"
    And port 22 accepts a connection
    When the public reachability of "worker-one" is checked
    Then the check fails
    And the summary of the check is "WORKER_PUBLIC_PORT_UNRESTRICTED SSH (tcp 22) accepted a connection on the worker's public address."
    And the checks do not contain "203.0.113.20"
    And the check does not block readiness

  Scenario: T3 on the public address fails
    Given Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "[2001:db8::20]:41641"
    And port 3773 accepts a connection
    When the public reachability of "worker-one" is checked
    Then the check fails
    And the summary of the check mentions "T3 (tcp 3773)"

  Scenario: SSH kept open by the break-glass opt-in is not tried
    Given the exposure policy is:
      """
      {"publicSsh": true}
      """
    And Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "203.0.113.20:41641"
    And port 22 accepts a connection
    When the public reachability of "worker-one" is checked
    Then the check passes
    And only these connections were tried:
      | 203.0.113.20:3773  |
      | 203.0.113.20:45876 |

  Scenario Outline: A worker reached only at <where> has no public address to try
    Given Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "<endpoints>"
    When the public reachability of "worker-one" is checked
    Then the check is not applicable
    And no connection was tried

    Examples:
      | where                    | endpoints                               |
      | a private network        | 192.168.1.20:41641, 10.0.0.4:41641      |
      | a link-local address     | [fe80::1]:41641                         |
      | its tailnet address      | 100.101.102.103:41641                   |
      | no endpoint              |                                         |

  Scenario: fleet-status --workers adds the check to every declared worker it reports
    Given Tailscale reaches "worker-one.tail0a1b2c.ts.net" at "203.0.113.20:41641"
    And no port accepts a connection
    When the manager adds public reachability to the reports of:
      | worker-one.tail0a1b2c.ts.net |
      | worker-two.tail0a1b2c.ts.net |
    Then the report of "worker-one.tail0a1b2c.ts.net" holds "worker:public-reachability" as "pass"
    And the report of "worker-two.tail0a1b2c.ts.net" holds "worker:public-reachability" as "not-applicable"
