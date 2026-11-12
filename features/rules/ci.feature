Feature: Every pull request is checked the way machines run

  Scenario: A service a check starts is pinned by digest
    When the service images of the "CI" workflow are read
    Then there is at least one
    And each is pinned by tag and SHA-256 digest

  Scenario: The fleet state check runs on every pull request and cannot skip
    Then the "CI" workflow runs on "pull_request"
    And its "state" job has no condition
    And its "state" job sets "DEVFLEET_TEST_LITESTREAM" to "required"
    And its "state" job points "DEVFLEET_TEST_S3" at a local S3 service

  Scenario Outline: The <job> check runs on every pull request
    Then the "CI" workflow runs on "pull_request"
    And its "<job>" job has no condition

    Examples:
      | job       |
      | check     |
      | state     |
      | fresh-box |
      | agent-box |
      | workflows |
      | ansible   |
      | manager   |

  Scenario: The fresh worker check covers every accepted release on both architectures a worker may have
    A release is accepted when every fresh-box scenario passes on it, so each
    release the Ubuntu policy accepts runs them on each architecture.
    Then the "CI" workflow runs on "pull_request"
    And its "fresh-box" job runs once for each of:
      | release | architecture | runner           |
      | 26.04   | amd64        | ubuntu-latest    |
      | 26.04   | arm64        | ubuntu-24.04-arm |
      | 24.04   | amd64        | ubuntu-latest    |
      | 24.04   | arm64        | ubuntu-24.04-arm |
    And its "fresh-box" job runs every release the Ubuntu policy accepts
    And its "fresh-box" job sets "DEVFLEET_TEST_FRESH_BOX_RELEASE" to "${{ matrix.release }}"

  Scenario: A fresh worker is bootstrapped over SSH on every pull request
    Then the "CI" workflow runs on "pull_request"
    And its "fresh-box" job has no condition
    And its "fresh-box" job runs "bun test features/fresh-box"
    And its "fresh-box" job sets "DEVFLEET_TEST_FRESH_BOX" to "required"

  Scenario: The monitoring agent is applied on a systemd machine on every pull request
    Then the "CI" workflow runs on "pull_request"
    And its "agent-box" job has no condition
    And its "agent-box" job runs "bun test features/monitoring"
    And its "agent-box" job sets "DEVFLEET_TEST_AGENT_BOX" to "required"

  Scenario: The agents play renders every CLI's configuration on every pull request and cannot skip
    Then the "CI" workflow runs on "pull_request"
    And its "check" job has no condition
    And its "check" job sets "DEVFLEET_TEST_ANSIBLE" to "required"

  Scenario: Every playbook is linted in the production profile and syntax-checked
    Then the "CI" workflow runs on "pull_request"
    And its "ansible" job has no condition
    And its "ansible" job runs "ansible-lint"
    And its "ansible" job runs "--syntax-check"
    And ".ansible-lint.yml" requires the profile "production"

  Scenario: The manager is checked on macOS on every pull request
    The manager runs only on macOS: launchd, pmset and Docker Desktop are
    proven there and not by stand-ins alone. The manager playbook is converged
    on the runner, then applied again and checked, and neither may change
    anything. The one administrator grant (sudoers, newsyslog drop-in, T3
    policy) is applied the same way, with the runner's sudo.
    Then the "CI" workflow runs on "pull_request"
    And its "manager" job has no condition
    And its "manager" job runs on "macos-latest"
    And its "manager" job runs "bun test"
    And its "manager" job runs "ansible/macos/manager.yml"
    And its "manager" job runs "converge --check --diff"
    And its "manager" job runs "changed=0"
    And its "manager" job runs "ansible/macos/manager-privilege.yml"

  Scenario: The real Ubuntu machine is tested weekly and can be run by hand
    Then the "Ubuntu VM" workflow runs on "schedule"
    And the "Ubuntu VM" workflow runs on "workflow_dispatch"
    And its "vm" job runs "bun ansible/ubuntu/tests/run-vm.ts"

  Scenario: Tailnet enrolment is tested weekly against a self-hosted control plane and can be run by hand
    Then the "Tailnet" workflow runs on "schedule"
    And the "Tailnet" workflow runs on "workflow_dispatch"
    And its "tailnet" job runs "bun test features/tailnet-box"
    And its "tailnet" job sets "DEVFLEET_TEST_TAILNET_BOX" to "required"

  Scenario: A release stamps the commit it is published from into the package
    fleet-sync run from the package converges every machine to the commit the
    package names, so a release that does not name one cannot move a fleet.
    When the "Pack the release" step of the "Release" workflow is read
    Then it runs "npm pkg set gitHead=\"$(git rev-parse HEAD)\"" before "npm pack"

  Scenario: Nothing is published until the packed release ran and the VM and tailnet tests passed for its commit
    A broken bin path, a file missing from the package, a machine the
    release cannot bring up or a worker that cannot join the tailnet fails
    the run before npm sees anything.
    Then the "Release" workflow's "release" job needs "pack", "smoke", "vm" and "tailnet"
    And its "smoke" job runs "bun bootstrap/package-smoke.ts"
    And its "smoke" job runs once for each of:
      | node |
      | 22   |
      | 24   |
    And its "vm" job calls ".github/workflows/vm.yml" for the commit "pack" packed
    And its "tailnet" job calls ".github/workflows/tailnet.yml" for the commit "pack" packed
    When the "Publish to npm" step of the "Release" workflow is read
    Then it runs "npm publish \"$TARBALL\"" before "--provenance"

  Scenario: A release is described by the commits it contains
    When the "Tag and release" step of the "Release" workflow is read
    Then it runs "gh release create" before "--notes-file"
