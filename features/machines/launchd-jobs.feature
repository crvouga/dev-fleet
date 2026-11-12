@macos
Feature: Every launchd job the manager runs is a property list launchd accepts
  The manager runs only on macOS, so this is checked by macOS itself
  (plutil -lint) on a macOS runner on every pull request, not by a parser
  that might accept what launchd refuses.

  Scenario: The CLI proxy's launchd jobs are valid property lists
    When every launchd job under "cliproxy/launchd" is linted by macOS
    Then each is valid

  Scenario: A scheduled job with characters XML must escape renders a valid property list
    Given a scheduled job "dev.devfleet.fixture" that runs "/bin/echo" "a & b <c>" every 3600 seconds
    When its launchd job is rendered and linted by macOS
    Then each is valid
