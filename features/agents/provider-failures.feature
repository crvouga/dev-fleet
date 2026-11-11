Feature: A provider failure is reported as a stable code
  A diagnostic names one of a few known conditions. What a provider or an
  exception said is never passed on: it may hold anything.

  Rule: A rejection distinguishes credentials, quota, the provider and the protocol

    Scenario Outline: The gateway's status <status> is <code>
      When the gateway rejects a verification request with the status <status>
      Then the failure is reported as "<code>"

      Examples:
        | status | code                          |
        | 401    | PROVIDER_AUTH_REJECTED        |
        | 429    | PROVIDER_RATE_LIMITED         |
        | 503    | PROVIDER_UPSTREAM_UNAVAILABLE  |
        | 400    | PROVIDER_PROTOCOL_REJECTED     |
        | 404    | PROVIDER_PROTOCOL_INCOMPATIBLE |
        | 405    | PROVIDER_PROTOCOL_INCOMPATIBLE |
        | 415    | PROVIDER_PROTOCOL_INCOMPATIBLE |
        | 501    | PROVIDER_PROTOCOL_INCOMPATIBLE |

  Rule: An unexpected private error never becomes a diagnostic code

    Scenario Outline: <what>
      When a verification request fails with <error> that says "<message>"
      Then the failure is reported as "<code>"

      Examples:
        | what                                        | error       | message                    | code                        |
        | An unknown error says only that it happened | an Error    | PRIVATE_SENTINEL           | PROVIDER_ROUTE_UNVERIFIED   |
        | A failed connection says only that it did   | a TypeError | PRIVATE_SENTINEL           | PROVIDER_NETWORK_UNVERIFIED |
        | An error that is a known code keeps it      | an Error    | PROVIDER_STREAM_INCOMPLETE | PROVIDER_STREAM_INCOMPLETE  |

  Rule: Provider account conditions warn; gateway and credential failures fail
    Rate limits and exhausted quota are expected on a shared account, which
    recovers on its own: they are a quiet pass. An outage or a refused model
    is the provider's, so it never fails a sync. Anything else means this
    machine is misconfigured.

    Scenario Outline: <code> on the codex route is a <status>
      When the inference check of "codex" fails with "<code>"
      Then the check has the status "<status>"

      Examples:
        | code                          | status |
        | PROVIDER_RATE_LIMITED         | pass   |
        | PROVIDER_UPSTREAM_UNAVAILABLE | warn   |
        | PROVIDER_MODEL_UNAVAILABLE    | warn   |
        | PROVIDER_TIMEOUT              | warn   |
        | PROVIDER_AUTH_REJECTED        | fail   |
        | PROVIDER_NETWORK_UNVERIFIED   | fail   |
        | PROVIDER_PROTOCOL_INCOMPATIBLE | fail  |

    Scenario: A route the gateway cannot serve fails and names the supported alternative
      Nothing on the machine can fix it, so it is never a warning that a
      sync could pass with.
      When the inference check of "codex" fails with "PROVIDER_PROTOCOL_INCOMPATIBLE"
      Then the check has the status "fail"
      And the remedy of the check names "Supported alternatives" in "agents/setup.md"
