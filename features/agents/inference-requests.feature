Feature: Each agent's route is proven in the protocol its client speaks
  The pinned clients use different wire protocols, and listing models is not
  inference: a route is verified by asking it to reply.

  Scenario: Native Gemini uses generateContent rather than an OpenAI inference request
    When the inference request of "gemini" on the machine "devbox" through the proxy is built
    Then it is sent to "/v1beta/models/gemini-3-flash:generateContent"
    And its body is:
      """
      {
        "contents": [{ "role": "user", "parts": [{ "text": "Reply OK." }] }],
        "generationConfig": { "maxOutputTokens": 1024 }
      }
      """

  Scenario Outline: <tool> keeps its own gateway protocol
    When the inference request of "<tool>" on the machine "devbox" through the proxy is built
    Then it is sent to "<path>"

    Examples:
      | tool   | path          |
      | claude | /v1/messages  |
      | codex  | /v1/responses |
