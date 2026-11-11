Feature: What a manager kept in files before the fleet state existed moves into it
  A manager that has no state database yet still reads the files that held
  its configuration, roster and enrollment. Its first change moves every valid
  one into the fleet state, and nothing reads or writes the files afterwards.
  In a path, `~` is the manager's home.

  Rule: Earlier files are read until the manager has a state, then moved all at once

    Background:
      Given the manager kept its roster in "~/.config/personal/fleet.json":
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """
      And the manager kept its enrollment in "~/.local/share/personal/fleet/manager/enrollment.json":
        """
        not json
        """

    Scenario: The earlier roster is read while there is no state
      When the roster "state:roster" of the manager is read as text
      Then it reads:
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """
      And no state database exists

    Scenario: The first change creates the state with every valid earlier document
      So the roster does not vanish when something else is written first. An
      enrollment that is not valid is not moved.
      When the roster "state:roster" of the manager is written as:
        """
        {"version":1,"nodes":[{"id":"worker-two","ssh":"worker-two","workspace":"/"}]}
        """
      Then the fleet state of the manager holds the roster:
        """
        {"version":1,"nodes":[{"id":"worker-two","ssh":"worker-two","workspace":"/"}]}
        """
      And the fleet state of the manager holds no enrollment

    Scenario: From then on the state is the only place read
      Given the roster "state:roster" of the manager was written as:
        """
        {"version":1,"nodes":[{"id":"worker-two","ssh":"worker-two","workspace":"/"}]}
        """
      When the earlier files of the manager are moved into the fleet state
      Then nothing is moved
      And the earlier roster of the manager is no longer read
      And "~/.config/personal/fleet.json" on the manager still holds:
        """
        {"version":1,"nodes":[{"id":"worker-one","ssh":"worker-one","workspace":"/"}]}
        """

    Scenario: A state directory named explicitly is another fleet's
      Given commands on the manager are passed:
        | DEVFLEET_STATE | /elsewhere |
      Then the manager has no earlier roster file

  Rule: A configuration kept in a file of your own is not copied into the state

    Background:
      Given the manager kept the example fleet.json as its configuration in "~/.config/dev-fleet/fleet.json"

    Scenario: With a fleet.json named, the installed copy stays where it is
      Given commands on the manager are passed:
        | DEVFLEET_CONFIG | /repo/fleet.json |
      When the earlier files of the manager are moved into the fleet state
      Then nothing is moved
      And no state database exists

    Scenario: With none named, the installed copy becomes the stored configuration
      When the earlier files of the manager are moved into the fleet state
      Then these documents are moved:
        | definition |

  Rule: The approved revision moves from its earlier file into the state

    Background:
      Given commands on the manager are passed:
        | DEVFLEET_STATE | ~/state |
      And "~/manager/enrollment.json" on the manager holds:
        """
        {"version":1,"id":"manager","approvedRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        """

    Scenario: The earlier file is read while there is no state
      When the enrollment of the manager is loaded, with "~/manager" as where it was kept before
      Then its approved revision is "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    Scenario: Without the earlier directory there is no enrollment yet
      When the enrollment of the manager is loaded
      Then there is no enrollment

    Scenario: An approval stored in the state replaces the earlier file
      Given the manager stored the enrollment:
        """
        {"version":1,"id":"manager","approvedRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        """
      When the enrollment of the manager is loaded, with "~/manager" as where it was kept before
      Then its approved revision is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    Scenario: An enrollment in the state that is not valid is refused, never replaced by a guess
      Given the manager stored the enrollment:
        """
        {"version":1,"id":"manager","approvedRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        """
      And the enrollment was stored as '{"version":1}'
      When the enrollment of the manager is loaded, with "~/manager" as where it was kept before
      Then it is refused with "fleet-state --restore"
