Feature: The manager's enrollment from before it moved into the fleet state
  The manager's enrollment once lived in "enrollment.json" in its private
  state directory. Nothing writes that file now, but a manager that still has
  one is read from it exactly, and a file that is not a valid enrollment is
  refused instead of being taken for a manager that never enrolled.

  Background:
    Given an empty manager state directory

  Scenario: A manager without the file has no earlier enrollment
    When the earlier enrollment is read
    Then there is no earlier enrollment

  Scenario: The earlier enrollment is read exactly as it was written
    Given the directory holds "enrollment.json":
      """
      {
        "version": 1,
        "id": "manager",
        "approvedRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
      """
    When the earlier enrollment is read
    Then its approved revision is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And it names no applied revision

  Scenario: A file that is not an enrollment is refused
    Given the directory holds "enrollment.json":
      """
      {"version":1}
      """
    When the earlier enrollment is read
    Then it is refused with "Invalid enrollment"
