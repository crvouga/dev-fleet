Feature: Every check and code dev-fleet names is one it produces
  A check id or result code that nothing produces makes it impossible to tell
  which states are handled. The report groups checks by id and the documents
  and features explain T3 codes: each must come from the code that measures or recovers.

  Scenario: Every T3 check the fleet-sync report groups is produced
    When the check ids of the "T3" and "LINK" columns of the fleet-sync report are read
    Then there are more than 5
    And each is produced outside the report

  Scenario: Every T3 code the documents and features name is emitted
    When the T3 codes the documents and features name are read
    Then there are more than 5
    And each is emitted by the code that measures or recovers T3
