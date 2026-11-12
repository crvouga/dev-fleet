Feature: What a command prints with --json is published, and checked against what it prints
  An agent parses dev-fleet's output by its published schema, not by
  guesswork. Each schema under schema/output is checked here against what the
  command really prints, and every check ID the code can report is listed,
  with its meaning, in schema/check-ids.json.

  Rule: Each command's output matches its schema

    Scenario: A fleet-sync report is version 3
      When fleet-sync stops before it reaches a machine
      Then what it prints matches "schema/output/fleet-sync.schema.json"

    Scenario: A fleet-sync report that says it is version 1 does not match
      Given a fleet-sync report that says it is version 1
      Then it does not match "schema/output/fleet-sync.schema.json"

    Scenario: A fleet-status report is a version 1 diagnostic report
      When fleet-status checks this manager only, where every command succeeds
      Then what it prints matches "schema/output/report.schema.json"

    Scenario: fleet-report's output matches its schema
      When fleet-report reads a history of two runs
      Then what it prints matches "schema/output/fleet-report.schema.json"

    Scenario: A refused command prints an error document
      When a command is refused as a usage error
      Then what it prints matches "schema/output/error.schema.json"

  Rule: Every check ID is in the registry, with what it means

    Scenario: The registry and the code name the same checks
      Then every check ID the code reports is in the check-ID registry
      And the registry names no check the code no longer reports
      And every entry of the registry says what it means

  Rule: The agent guide points at the schemas and the registry

    Scenario: The agent guide names each schema and the registry, and the real report versions
      Then the agent guide names, for its output:
        | schema/output/report.schema.json       |
        | schema/output/fleet-sync.schema.json   |
        | schema/output/fleet-report.schema.json |
        | schema/output/error.schema.json        |
        | schema/check-ids.json                  |
      And the agent guide does not say every report is version 1
