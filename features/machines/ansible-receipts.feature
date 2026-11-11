Feature: An unchanged, verified playbook is not applied twice
  Ansible is idempotent but slow. A successful apply leaves a receipt: a
  digest of exactly what it was given (the playbook's sources and its
  variables, never the variables themselves). A later run with the same
  digest skips the playbook while a cheap postcondition still holds. Anything
  else applies in full again.

  Background:
    Given a playbook "site.yml" with these sources:
      | file        | content |
      | site.yml    | v1      |
      | tasks/a.yml | a       |
    And its applies are recorded in the receipt "site.json"
    And Ansible succeeds
    And the postcondition of the playbook holds

  Rule: The same sources and variables, still verified, are skipped

    Scenario: The first apply runs the playbook
      When the playbook is applied with the variables '{"a":1}'
      Then the playbook ran
      And Ansible ran 1 time in all
      And the receipt "site.json" does not contain '"a":1'

    Scenario: An unchanged, verified apply is skipped on the next run
      Given the playbook was applied with the variables '{"a":1}'
      When the playbook is applied with the variables '{"a":1}'
      Then the playbook was skipped
      And Ansible ran 1 time in all
      And the receipt "site.json" does not contain '"a":1'

  Rule: Anything that could change the result applies in full again

    Scenario: A source changed
      Given the playbook was applied with the variables '{"a":1}'
      And the source "tasks/a.yml" now holds "b"
      When the playbook is applied with the variables '{"a":1}'
      Then the playbook ran
      And Ansible ran 2 times in all

    Scenario: The variables changed
      Given the playbook was applied with the variables '{"a":1}'
      When the playbook is applied with the variables '{"a":2}'
      Then the playbook ran
      And Ansible ran 2 times in all

    Scenario: The postcondition no longer holds
      Given the playbook was applied with the variables '{"a":1}'
      And the postcondition of the playbook no longer holds
      When the playbook is applied with the variables '{"a":1}'
      Then the playbook ran
      And Ansible ran 2 times in all

    Scenario: The apply is forced
      Given the playbook was applied with the variables '{"a":1}'
      When the playbook is applied with the variables '{"a":1}', by force
      Then the playbook ran
      And Ansible ran 2 times in all

    Scenario: The receipt is a day old
      A full apply at least this often heals drift the postcondition misses.
      Given the playbook was applied with the variables '{"a":1}'
      When the playbook is applied with the variables '{"a":1}', 24 hours later
      Then the playbook ran
      And Ansible ran 2 times in all

  Rule: A failed apply leaves no receipt

    Scenario: A failed apply is reported as failed
      Given the playbook was applied with the variables '{"a":1}'
      And the source "site.yml" now holds "v2"
      And Ansible now fails
      When the playbook is applied with the variables '{"a":1}'
      Then the apply failed

    Scenario: After a failed apply the next run applies in full
      Even when the sources are again what the last receipt recorded.
      Given the playbook was applied with the variables '{"a":1}'
      And the source "site.yml" now holds "v2"
      And Ansible now fails
      And the playbook was applied with the variables '{"a":1}'
      And Ansible now succeeds
      And the source "site.yml" now holds "v1"
      When the playbook is applied with the variables '{"a":1}'
      Then the playbook ran
      And Ansible ran 3 times in all

  Rule: Sources that cannot be read never skip

    Scenario: A playbook whose sources are missing is applied every time
      Given the sources of the playbook are in a directory that does not exist
      And the playbook was applied with the variables '{}'
      When the playbook is applied with the variables '{}'
      Then the playbook ran
      And Ansible ran 2 times in all
