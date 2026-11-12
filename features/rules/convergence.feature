Feature: Every step that changes a machine outside Ansible is listed, with its reason
  Ansible is meant to be the one convergence engine. Until it is, every other
  step that changes a machine is named in docs/convergence.md with the reason
  it is not a task yet, so the list can only shrink and nothing is added to
  it unnoticed.

  Scenario: Every TypeScript file that runs a command changing a machine is listed
    When the TypeScript sources are searched for commands that change a machine
    Then each file found is named in "docs/convergence.md" with a reason

  Scenario: Every bootstrap step is listed
    When the bootstrap scripts and modules are listed
    Then each file found is named in "docs/convergence.md" with a reason

  Scenario: Every playbook is listed
    When every playbook is listed
    Then each file found is named in "docs/convergence.md"
