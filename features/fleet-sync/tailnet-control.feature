Feature: A tailnet control plane issues one single-use key per new worker
  A machine created by infrastructure-as-code has nobody at a console. The
  fleet declares its tailnet control plane in fleet.json (tailnet) and keeps an
  API credential for it as the secret tailnet-admin, which stays on the
  manager. For each new worker dev-fleet asks the control plane for one key:
  single-use, pre-authorised, tagged and expiring within minutes. The hosted
  Tailscale and a self-hosted Headscale both answer, so the contract is "a
  control plane that can issue pre-authorised keys", not one vendor.

  Background:
    Given the secrets provider holds a tailnet-admin credential generated for this scenario

  Rule: The hosted Tailscale, through its API v2

    Background:
      Given the fleet declares the tailnet control plane:
        """
        { "api": "tailscale", "tag": "tag:fleet-worker" }
        """

    Scenario: A key is single-use, pre-authorised, tagged and short-lived
      Given the control plane answers 200 with:
        """
        { "key": "tskey-auth-kexample-0123456789abcdef", "expires": "2026-11-12T10:10:00Z" }
        """
      When a key is created for "worker-one"
      Then the control plane was asked "POST" "https://api.tailscale.com/api/v2/tailnet/-/keys"
      And the request carried the credential as a bearer token
      And the request body holds:
        | field                                    | value            |
        | capabilities.devices.create.reusable     | false            |
        | capabilities.devices.create.ephemeral    | false            |
        | capabilities.devices.create.preauthorized | true            |
        | capabilities.devices.create.tags.0       | tag:fleet-worker |
        | expirySeconds                            | 600              |
      And the key it answers is "tskey-auth-kexample-0123456789abcdef"

    Scenario: The devices of the fleet are the ones that carry its tag
      Given the control plane answers 200 with:
        """
        {
          "devices": [
            { "id": "1001", "nodeId": "nWorkerOne", "hostname": "worker-one", "tags": ["tag:fleet-worker"] },
            { "id": "1002", "nodeId": "nLaptop", "hostname": "laptop", "tags": [] }
          ]
        }
        """
      When the devices tagged "tag:fleet-worker" are listed
      Then the control plane was asked "GET" "https://api.tailscale.com/api/v2/tailnet/-/devices"
      And the devices listed are:
        | id         | name       |
        | nWorkerOne | worker-one |

    Scenario: A device is deleted by its stable node ID
      Given the control plane answers 200 with:
        """
        {}
        """
      When the device "nWorkerOne" is deleted
      Then the control plane was asked "DELETE" "https://api.tailscale.com/api/v2/device/nWorkerOne"

    Scenario: An enrolled worker's node key is set never to expire
      Given the control plane answers 200 with:
        """
        {}
        """
      When key expiry of the device "nWorkerOne" is disabled
      Then the control plane was asked "POST" "https://api.tailscale.com/api/v2/device/nWorkerOne/key"
      And the request body holds:
        | field             | value |
        | keyExpiryDisabled | true  |

  Rule: A self-hosted Headscale, through its REST API

    Background:
      Given the fleet declares the tailnet control plane:
        """
        { "api": "headscale", "url": "https://headscale.example.org", "tag": "tag:fleet-worker", "user": "7" }
        """

    Scenario: A key is single-use, pre-authorised, tagged and short-lived
      Given the control plane answers 200 with:
        """
        { "preAuthKey": { "key": "0123456789abcdef0123456789abcdef0123456789abcdef", "expiration": "2026-11-12T10:10:00Z" } }
        """
      When a key is created for "worker-one"
      Then the control plane was asked "POST" "https://headscale.example.org/api/v1/preauthkey"
      And the request carried the credential as a bearer token
      And the request body holds:
        | field     | value            |
        | user      | 7                |
        | reusable  | false            |
        | ephemeral | false            |
        | aclTags.0 | tag:fleet-worker |
      And the key the request asks for expires within 10 minutes
      And the key it answers is "0123456789abcdef0123456789abcdef0123456789abcdef"

    Scenario: The devices of the fleet are the nodes that carry its tag
      Given the control plane answers 200 with:
        """
        {
          "nodes": [
            { "id": "12", "givenName": "worker-one", "forcedTags": ["tag:fleet-worker"] },
            { "id": "13", "givenName": "laptop", "validTags": [] }
          ]
        }
        """
      When the devices tagged "tag:fleet-worker" are listed
      Then the control plane was asked "GET" "https://headscale.example.org/api/v1/node"
      And the devices listed are:
        | id | name       |
        | 12 | worker-one |

    Scenario: A node is deleted by its ID
      Given the control plane answers 200 with:
        """
        {}
        """
      When the device "12" is deleted
      Then the control plane was asked "DELETE" "https://headscale.example.org/api/v1/node/12"

    Scenario: A node registered with a pre-authorised key never expires, so nothing is asked
      When key expiry of the device "12" is disabled
      Then the control plane was asked nothing

  Rule: The worker joins with its key once, and forgets it

    Scenario: The Tailscale play joins only a node that was never logged in, reading the key from a root-only file
      A worker with Tailscale state keeps its identity: it is never re-joined
      or reset. The key is read by tailscale itself, so it is never an
      argument, and it is deleted whether or not the join succeeded. The tag
      comes with the key: Headscale refuses a pre-authorised join that also
      advertises tags, which features/tailnet-box proves against a real one.
      When the Tailscale play of a worker is read
      Then its join runs only when these hold:
        | tailnet_key.stat.exists                                       |
        | (tailscale_status.stdout \| from_json).BackendState == 'NeedsLogin' |
      And its join passes "--auth-key=file:/run/devfleet/tailnet-auth-key" and the declared worker ID as the hostname
      And its join advertises no tag: the key carries the fleet's tag
      And its join logs nothing
      And after the join the key file is removed, whatever the join did
      And without a join it still stops with "TAILSCALE_LOGIN_REQUIRED"

  Rule: Nothing the control plane answers is reported

    Background:
      Given the fleet declares the tailnet control plane:
        """
        { "api": "tailscale", "tag": "tag:fleet-worker" }
        """

    Scenario Outline: A control plane that answers <status> is reported as <code>, without its answer
      Given the control plane answers <status> with:
        """
        { "message": "PRIVATE_SENTINEL" }
        """
      When a key is created for "worker-one"
      Then it is refused with "<code>"
      And "PRIVATE_SENTINEL" appears nowhere in the refusal

      Examples:
        | status | code                        |
        | 401    | TAILNET_CONTROL_DENIED      |
        | 403    | TAILNET_CONTROL_DENIED      |
        | 400    | TAILNET_CONTROL_REJECTED    |
        | 503    | TAILNET_CONTROL_UNAVAILABLE |

    Scenario: An answer that is not a key is refused
      Given the control plane answers 200 with:
        """
        { "key": "short", "expires": "2026-11-12T10:10:00Z" }
        """
      When a key is created for "worker-one"
      Then it is refused with "TAILNET_CONTROL_RESPONSE_INVALID"

    Scenario: A declared control plane without its credential is refused before anything is asked
      Given the secrets provider holds no tailnet-admin credential
      When a key is created for "worker-one"
      Then it is refused with "TAILNET_ADMIN_REQUIRED"
      And the control plane was asked nothing
