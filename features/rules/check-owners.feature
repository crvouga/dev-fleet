Feature: Every check is repaired by a recipe, or says why only a person can
  fleet-repair turns failing checks into repairs. A check is owned by a
  recipe (a playbook the machine already applies, restricted to one tag, or a
  fixed command), or by a documented reason it is left to a person: a
  sign-in, a choice in fleet.json, the hardware.

  Scenario: Every check ID the sources report has an owner
    When the check IDs the sources report are listed
    Then more than 100 check IDs were found
    And every check ID found maps to a repair recipe or to a documented manual reason

  Scenario Outline: "<check>" is repaired by <recipe>
    Then the check "<check>" is repaired by "<recipe>"

    Examples:
      | check                   | recipe       |
      | worker:service-recovery | recovery     |
      | worker:capacity:disk    | disk         |
      | beszel:agent            | monitoring   |
      | beszel:service          | monitoring   |
      | tailscale:online        | network      |
      | state:replica           | state        |
      | tool:node               | workspace    |
      | auth:codex              | login:codex  |
      | tailscale:identity      | a person     |
      | ssh:host-key            | a person     |
      | worker:power-loss-recovery | a person  |

  Scenario: A machine repair runs one tag of a playbook the machine already applies
    Then every recipe that repairs a machine names a playbook, a tag and nothing else

  Scenario: The plan names the recipe for one check and the reason for the other
    Then a plan for a worker failing "worker:capacity:disk" and "ssh:host-key" says why the second is left to a person
