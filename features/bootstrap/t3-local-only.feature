Feature: A worker's T3 desktop app starts serving on loopback only
  The worker's route is tailscale serve to 127.0.0.1, so its T3 never needs to
  listen beyond loopback. The desktop app reads its exposure from its own
  desktop settings and the T3 service environment when it starts, and the
  running app rewrites its settings from memory. So before the app starts,
  both are put back to local-only. Every other setting is kept, and a file
  that cannot be read is left as it is.

  Scenario: A network-accessible app is put back to local-only, keeping its other settings
    Given the desktop settings are:
      """
      {"serverExposureMode": "network-accessible", "tailscaleServeEnabled": true}
      """
    And the T3 service environment is:
      """
      T3CODE_LAN=true
      """
    When the exposure is set before the app starts
    Then the desktop settings become:
      """
      {"serverExposureMode": "local-only", "tailscaleServeEnabled": true}
      """
    And the T3 service environment becomes:
      """
      T3CODE_LAN=false
      """
    And it reports:
      """
      {"desktopSettings": "changed", "serviceEnvironment": "changed"}
      """

  Scenario: An app already on loopback is left untouched
    Given the desktop settings are:
      """
      {"tailscaleServeEnabled": true}
      """
    And the T3 service environment is:
      """
      T3CODE_LAN=false
      """
    When the exposure is set before the app starts
    Then the desktop settings become:
      """
      {"tailscaleServeEnabled": true}
      """
    And it reports:
      """
      {"desktopSettings": "kept", "serviceEnvironment": "kept"}
      """

  Scenario: Settings that cannot be parsed are left alone and reported
    Given the desktop settings hold "{not json"
    When the exposure is set before the app starts
    Then the desktop settings still hold "{not json"
    And it reports:
      """
      {"desktopSettings": "unreadable", "serviceEnvironment": "absent"}
      """
