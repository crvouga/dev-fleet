Feature: A provider is proven with a bounded round trip
  An HTTP 200 proves little. The route is asked three things in turn: to
  stream a reply to its end, to call the one tool it is offered, and to
  return what the tool gave back. The tool is a local echo of a nonce, so
  nothing a model says can select a command, a file or a URL.

  Scenario: A completed stream and a validated echo verify the provider
    Given a provider that streams these events:
      | {"type":"response.output_text.delta","delta":"OK"} |
      | {"type":"response.completed"}                      |
    And the provider answers a tool request by calling "fleet_echo" as the call "call-1", with the nonce it was offered
    And the provider then replies with the result of the call
    When the provider is verified with the model "fixture-model" and the key "private-test-key"
    Then the provider is verified
    And 3 requests were sent
    And every request refuses to follow a redirect
    And the last request returns the nonce as the output of the call "call-1"
    And no request contains "private-test-key"

  Scenario: A call to an unexpected tool is never executed or returned to the model
    Given a provider that streams these events:
      | {"type":"response.output_text.delta","delta":"OK"} |
      | {"type":"response.completed"}                      |
    And the provider answers a tool request by calling "shell" as the call "call-1", with the nonce it was offered
    And the provider then replies with the result of the call
    When the provider is verified with the model "fixture-model" and the key "private-test-key"
    Then verification fails with "PROVIDER_TOOL_INVALID"
    And 2 requests were sent
    And every request refuses to follow a redirect

  Scenario: HTTP 200 and a partial stream are not enough, and no tool request follows
    Given a provider that streams these events:
      | {"type":"response.output_text.delta","delta":"OK"} |
    And the provider answers a tool request by calling "fleet_echo" as the call "call-1", with the nonce it was offered
    And the provider then replies with the result of the call
    When the provider is verified with the model "fixture-model" and the key "private-test-key"
    Then verification fails with "PROVIDER_STREAM_INCOMPLETE"
    And 1 request was sent
    And every request refuses to follow a redirect
