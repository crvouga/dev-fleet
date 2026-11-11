Feature: The account relay
  The proxy routes a model named "<prefix>/<model>" only to the account that
  owns the prefix, but an agent sends whichever model its user picked. A
  loopback relay that lives only as long as its agent adds the prefix to each
  request and forwards everything else (credentials, streaming) unchanged.

  Rule: The relay pins the model and leaves everything else alone

    Scenario Outline: <rule>
      When the request body <body> is pinned to the account prefix "<prefix>"
      Then the body sent on is <sent>

      Examples:
        | rule                                                  | body                        | prefix  | sent                                |
        | A model is given the prefix of the account            | {"model":"m","stream":true} | p-a@b.c | {"model":"p-a@b.c/m","stream":true} |
        | A model that already carries the prefix is left alone | {"model":"p-a@b.c/m"}       | p-a@b.c | {"model":"p-a@b.c/m"}               |
        | A body that is not JSON is left alone                 | not json                    | p       | not json                            |

    Scenario: A request reaches the proxy pinned, with its query and credentials intact
      The relay decodes the proxy's answer, so the answer no longer says how
      it was encoded.
      Given the proxy at "https://proxy.example" streams the event "data: ok" with these headers:
        | content-encoding | gzip              |
        | content-type     | text/event-stream |
      When an agent pinned to "claude-a@b.c" posts {"model":"m"} to "/v1/messages?beta=true" with these headers:
        | authorization | Bearer k         |
        | content-type  | application/json |
      Then the proxy received exactly this request:
        | url           | https://proxy.example/v1/messages?beta=true |
        | body          | {"model":"claude-a@b.c/m"}                  |
        | authorization | Bearer k                                    |
      And the agent receives the event "data: ok"
      And the answer carries no "content-encoding" header

    Scenario: A compressed request is refused and never reaches the proxy
      A body the relay cannot read could not be pinned; it is never forwarded
      to the pool of accounts.
      Given the proxy at "https://proxy.example" streams the event "data: ok"
      When an agent pinned to "p" posts x to "/v1/responses" with these headers:
        | content-encoding | zstd |
      Then the agent receives the status 415
      And the proxy received no request

  Rule: A route outage is retried until the proxy answers; the agent never sees it

    Scenario: The same request is sent again after each answer of a route that is down
      Given the proxy at "https://proxy.example" answers in turn:
        | status | body         |
        | 530    | tunnel error |
        | 502    | tunnel error |
        | 200    | ok           |
      When an agent pinned to "p-a@b.c" posts {"model":"m"} to "/v1/messages"
      Then the agent receives the status 200
      And the agent receives the body "ok"
      And the relay waited for 1, 2 seconds in turn
      And every attempt carried the body {"model":"p-a@b.c/m"}

    Scenario: A provider's own error is the proxy's answer and is returned at once
      Given the proxy at "https://proxy.example" always answers with the status 429 and the body "rate limited"
      When an agent pinned to "p" posts {"model":"m"} to "/v1/messages"
      Then the agent receives the status 429
      And the relay never waited

    Scenario: An outage longer than every delay returns the last answer
      Given the proxy at "https://proxy.example" always answers with the status 530 and the body "down"
      When an agent pinned to "p" posts {"model":"m"} to "/v1/messages"
      Then the agent receives the status 530
      And the proxy was asked 7 times, once more than the relay has retry delays

  Rule: A running relay serves a real loopback request

    Scenario: An agent's request passes through a listening relay
      Given a proxy on the loopback interface that answers with the path and body it was sent
      And a relay running for the account prefix "codex-a@b.c"
      When an agent posts {"model":"gpt-x"} to "/v1/responses" on the relay
      Then the proxy was sent the path "/v1/responses" and the body:
        """
        {"model": "codex-a@b.c/gpt-x"}
        """
