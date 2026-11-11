Feature: What the hub knows about a machine is read, never changed
  The manager asks the hub three things about a machine: the hub's release,
  the machine's one registration and its newest sample. Being registered and
  sending fresh metrics are separate checks. A record holds a token, a host
  and user information, so nothing of a record is repeated in the evidence.

  Rule: A machine passes with one registration, a connected agent and a fresh sample

    Background:
      Given the hub "https://home.example.ts.net:8443" answers:
        | request                                | answer                                                                          |
        | /api/beszel/info                       | {"v":"0.21.1","key":"never-output-key"}                                         |
        | /api/collections/systems/records…      | {"items":[{"id":"abcdefghijklmno","status":"up","token":"never-output-token"}]} |
        | /api/collections/system_stats/records… | {"items":[{"created":"2026-11-06T11:59:59.000Z"}]}                              |
      And the manager's clock reads "2026-11-06T12:00:00Z"

    Scenario: An authenticated registration and fresh metrics are each required, and each passes
      When the hub's evidence about the machine "devbox" is read
      Then every check passes
      And the newest sample was received at "2026-11-06T11:59:59.000Z"
      And the evidence does not contain "never-output"

    Scenario: A stopped agent and a stale sample cannot pass
      Given the hub answers:
        | request                                | answer                                                                            |
        | /api/collections/systems/records…      | {"items":[{"id":"abcdefghijklmno","status":"down","token":"never-output-token"}]} |
        | /api/collections/system_stats/records… | {"items":[{"created":"2026-11-06T11:50:00.000Z"}]}                                |
      When the hub's evidence about the machine "devbox" is read
      Then exactly these checks fail:
        | beszel:connection |
        | beszel:freshness  |

    Scenario Outline: A machine with <how many> registrations fails, and none is created
      Given the hub answers:
        | request                           | answer    |
        | /api/collections/systems/records… | <records> |
      When the hub's evidence about the machine "devbox" is read
      Then the last check fails
      And the summary of the last check is "<summary>"
      And the hub was asked 2 times

      Examples:
        | how many | records                                                                                                                                             | summary               |
        | no       | {"items":[]}                                                                                                                                        | BESZEL_NODE_MISSING   |
        | two      | {"items":[{"id":"abcdefghijklmno","status":"up","token":"never-output-token"},{"id":"abcdefghijklmno","status":"up","token":"never-output-token"}]} | BESZEL_DUPLICATE_NODE |

  Rule: An outage is evidence too, bounded and redacted

    Scenario: A hub that cannot be asked is reported without the error it gave
      Given the hub "https://home.example.ts.net:8443" fails every request with the error "SECRET"
      When the hub's evidence about the machine "devbox" is read
      Then the summary of the last check is "BESZEL_API_UNVERIFIED"
      And the evidence does not contain "SECRET"

  Rule: The hub is only ever reached at its private address, with a plain read

    Scenario Outline: An address that is <why> is refused
      Then "<address>" is refused as the address of the private hub

      Examples:
        | why                  | address                               |
        | not on a tailnet     | https://example.com:8443              |
        | not HTTPS            | http://home.ts.net:8443               |
        | carrying credentials | https://u:p@home.ts.net:8443          |
        | carrying a path      | https://home.example.ts.net:8443/path |

    Scenario: A read follows no redirect and mints no authentication
      Given a hub at "https://home.example.ts.net:8443" that answers every request with "{}"
      When "/api/beszel/info" is read from the hub with the token "secret"
      Then the request refuses to follow a redirect
      And the request names no method
