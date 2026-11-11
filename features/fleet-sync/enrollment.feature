Feature: Enrollment binds a device to a roster entry and never replaces what is there
  Discovery may add the Tailscale identity of a worker that was first reached
  over SSH. It never replaces a path, a capability or an identity the roster
  already holds.

  Scenario: Resuming an SSH enrollment binds the identity without replacing paths or capabilities
    Given the roster enrolls:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    | true            |             |
    And discovery finds:
      | id     | ssh    | workspace  | runtime        | required | bootstrapViaSsh | tailscaleId   |
      | devbox | devbox | /different | /different/bun |          | true            | stable-device |
    When what discovery found is merged into the roster
    Then the merged roster is exactly:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId   |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    |                 | stable-device |
    But the roster it started from still enrolls:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    | true            |             |

  Scenario: Merging the same discovery again changes nothing
    Given the roster enrolls:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId   |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    |                 | stable-device |
    And discovery finds:
      | id     | ssh    | workspace  | runtime        | required | bootstrapViaSsh | tailscaleId   |
      | devbox | devbox | /different | /different/bun |          | true            | stable-device |
    When what discovery found is merged into the roster
    Then the merged roster is exactly:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId   |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    |                 | stable-device |

  Scenario: Discovery cannot replace the identity of an enrolled device
    Given the roster enrolls:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    | true            | original    |
    And discovery finds:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    | true            | replacement |
    When what discovery found is merged into the roster
    Then the merged roster is exactly:
      | id     | ssh    | workspace                  | runtime          | required | bootstrapViaSsh | tailscaleId |
      | devbox | devbox | /home/dev/dirty-repository | /opt/bun/bin/bun | codex    | true            | original    |
