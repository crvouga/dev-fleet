Feature: One page says what a machine must offer to be a worker, and its checks are real
  docs/worker-requirements.md is the only list of what a machine needs before
  it can be a worker. Each requirement a check enforces names the check and
  the failure code it reports, so a person or an agent writing the
  infrastructure code can check a machine before renting it, and so the page
  cannot drift from what dev-fleet measures. A check of what the machine
  itself must offer carries "requirement": true in schema/check-ids.json.

  Scenario: Every requirement names a registered check and codes the runbooks explain
    When the requirements in "docs/worker-requirements.md" are read
    Then it lists at least 10 requirements
    And each names a check the check-ID registry holds
    And each code it names has an entry in "docs/runbooks.md"

  Scenario: Every check the registry marks as a worker requirement has a row on the page
    When the requirements in "docs/worker-requirements.md" are read
    Then every check the registry marks as a worker requirement is named by one of them

  Scenario: The page states the releases, architectures and size the Ubuntu policy accepts
    When the requirements in "docs/worker-requirements.md" are read
    Then they name every release the Ubuntu policy accepts, with its codename and architectures
    And they name the minimum worker size of the Ubuntu policy

  Scenario Outline: A requirement that names <what> is caught
    When this requirement is read:
      """
      | Requirement | How to check it | Check | Failure code |
      | ----------- | --------------- | ----- | ------------ |
      | Something   | `true`          | <check> | <code>     |
      """
    Then it is refused because <reason>

    Examples:
      | what                        | check                  | code                             | reason                              |
      | a check nobody reports      | `teleport:worker`      | -                                | "teleport:worker is not registered" |
      | a code without a runbook    | `platform:environment` | `WORKER_TELEPORT_UNSUPPORTED`    | "WORKER_TELEPORT_UNSUPPORTED has no runbook entry" |
      | no check at all             | -                      | `WORKER_ENVIRONMENT_UNSUPPORTED` | "a row names no check"              |

  Scenario: The documents that listed requirements of their own point at the page
    Then each of these documents links to "worker-requirements.md":
      | README.md               |
      | docs/consumer-setup.md  |
      | docs/worker-contract.md |
      | docs/ubuntu-sync.md     |
      | docs/topology.md        |
