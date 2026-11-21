Feature: A desktop worker's T3 renderers run under a memory ceiling of their own
  The desktop app's unit starts it in a delegated subgroup, app. The recovery
  check moves every renderer out of it into a renderers subgroup with the
  declared memory.high and memory.max, so memory pressure reclaims or ends a
  renderer, never the T3 server. Chromium rewrites a renderer's process
  title, so its arguments read as one line joined by spaces.

  Scenario: Renderers move into their subgroup, however their arguments read, and nothing else does
    Given the desktop app's subgroup holds these processes:
      | pid | arguments                                                           |
      | 101 | /opt/T3 Code (Nightly)/t3code --type=renderer --enable-crash-reporter |
      | 102 | /opt/T3 Code (Nightly)/t3code\0--type=renderer\0--lang=en-US          |
      | 103 | /opt/T3 Code (Nightly)/t3code --type=zygote                           |
      | 104 | /opt/T3 Code (Nightly)/t3code\0--ozone-platform=x11                   |
    When the renderer limits of 6144 MiB high and 8192 MiB max are applied
    Then the renderers subgroup holds 101 and 102
    And the renderers subgroup has memory.high 6442450944 and memory.max 8589934592
    And the desktop app's unit has the memory controller enabled for its subgroups

  Scenario: A process that left the subgroup while it was read stays where it is
    Given the desktop app's subgroup holds these processes:
      | pid | arguments                                    |
      | 101 | /opt/T3 Code (Nightly)/t3code --type=renderer |
    But process 101 now runs in the application scope of the app
    When the renderer limits of 6144 MiB high and 8192 MiB max are applied
    Then the renderers subgroup holds no process
