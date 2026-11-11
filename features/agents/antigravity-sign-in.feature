Feature: Antigravity signs in with the proxy key
  T3's managed policy may not carry a credential, so its Antigravity keeps
  the default Google sign-in method. The proxy key is the credential: the one
  "authenticate" request is switched to the Gemini API-key method on its way
  in, and every other message passes unchanged.

  Rule: Only an authenticate request for a browser sign-in becomes the API-key method

    Scenario: A browser sign-in is switched to the API key
      When T3 sends Antigravity the message:
        """
        {"jsonrpc":"2.0","id":3,"method":"authenticate","params":{"methodId":"oauth-personal"}}
        """
      Then Antigravity receives:
        """
        {"jsonrpc":"2.0","id":3,"method":"authenticate","params":{"methodId":"gemini-api-key"}}
        """

    Scenario: A sign-in by any other method passes unchanged
      When T3 sends Antigravity the message:
        """
        {"jsonrpc":"2.0","id":3,"method":"authenticate","params":{"methodId":"agent-platform"}}
        """
      Then Antigravity receives the message unchanged

    Scenario: A prompt that only mentions "authenticate" passes unchanged
      When T3 sends Antigravity the message:
        """
        {"method":"session/prompt","params":{"text":"\"authenticate\""}}
        """
      Then Antigravity receives the message unchanged

    Scenario: A line that is not JSON passes unchanged
      When T3 sends Antigravity the message:
        """
        not json "authenticate"
        """
      Then Antigravity receives the message unchanged
