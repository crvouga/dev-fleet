Feature: The manager converges itself before any worker
  The manager converges itself locally, never over SSH. It gets the same T3
  provider instances and the same proxy agent profiles as every worker, never
  sleeps on AC power, and hosts the fleet's services in Docker Desktop.

  Rule: T3 on the manager offers the managed provider instances

    Background:
      Given the proxy has these accounts signed in:
        | tool  | email         | prefix              | models |
        | codex | a@example.com | codex-a@example.com | gpt-x  |

    Scenario: A plan reports pending providers without writing
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      When the providers of "manager-mac" are planned
      Then the check's status is "warn"
      And the check's summary is "T3_PROVIDERS_PENDING"
      And T3 has exactly these provider instances:
        | antigravity |

    Scenario: Applying adds the declared providers and keeps the others
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      When the providers of "manager-mac" are applied
      Then the check's status is "pass"
      And T3 has exactly these provider instances:
        | antigravity                  |
        | personal_codex_a_example_com |
        | personal_gateway_models      |
        | personal_grok_proxy          |
      And the provider instance "personal_codex_a_example_com" is displayed as "Codex a@example.com"
      And the provider instances name "manager-mac"

    Scenario: Once applied, a plan has nothing left to do
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"antigravity":{}}}
        """
      And the providers of "manager-mac" have been applied
      When the providers of "manager-mac" are planned
      Then the check's status is "pass"

    Scenario: An unowned instance with a managed ID is reported, never overwritten
      Given T3 on the manager is configured with:
        """
        {"providerInstances":{"personal_grok_proxy":{"driver":"grok"}}}
        """
      When the providers of "manager-mac" are applied
      Then the check's status is "fail"
      And the check's summary is "T3_PROVIDER_CONFLICT"
      And the provider instances of T3 are exactly:
        """
        {"personal_grok_proxy":{"driver":"grok"}}
        """

  Rule: The manager applies every proxy agent profile the workers get

    Scenario: A profile is applied for every tool
      Given every agent profile applies cleanly
      When the agent profiles of "manager-mac" are applied
      Then the first check's status is "pass"
      And a profile was applied for each of these tools, in this order:
        | codex       |
        | claude      |
        | gemini      |
        | opencode    |
        | grok        |
        | antigravity |
      And every profile was applied with "--yes"
      And every profile was applied with "--profile" set to "proxy"
      And every profile was applied with "--node" set to "manager-mac"

    Scenario: A failed profile fails the manager and names the tool to fix
      Given every agent profile applies cleanly, except that of "claude"
      When the agent profiles of "manager-mac" are applied
      Then the first check's status is "fail"
      And the first check's summary is "MANAGER_AGENT_PROFILES_FAILED"
      And the first check's remedy contains "--tool claude"

  Rule: The manager never sleeps on AC power
    The check reads the settings from the policy file the playbook applies, so
    a setting added there is measured without a change here.

    Background:
      Given pmset reports on battery power:
        | sleep | 1 |
        | womp  | 0 |

    Scenario: A manager with every setting of its power policy passes
      Given pmset reports on AC power every setting the manager's power policy declares
      When the power settings of the manager are measured
      Then the check's status is "pass"

    Scenario: A manager that sleeps on AC power is named as such
      Given pmset reports on AC power every setting the manager's power policy declares, but "sleep" as "10"
      When the power settings of the manager are measured
      Then the check's summary is "MANAGER_SLEEPS_ON_POWER"

    Scenario: Every other setting the policy declares is measured, and the remedy applies the playbook
      When each setting the manager's power policy declares, except "sleep", is in turn reported as "other" on a manager whose checkout is "/fleet/checkout"
      Then each time the check's status is "fail"
      And each time the check's summary is "MANAGER_POWER_POLICY_DRIFT" and the name of that setting
      And each time the check's remedy contains "cd /fleet/checkout && "
      And each time the check's remedy ends with "-K ansible/macos/manager-privilege.yml"

  Rule: Once granted, every sync holds the power policy with no prompt
    The administrator grants the manager its power settings once, with
    manager-privilege.yml; from then on an applying sync applies manager.yml
    whenever the settings drifted, and asks nobody for a password.

    Scenario: A drifted manager with the grant is brought back by the sync
      Given pmset reports on AC power every setting the manager's power policy declares, but "sleep" as "10"
      And the manager's power grant is in place
      When an applying sync holds the manager's power policy
      Then the check's status is "pass"
      And manager.yml was applied without a password prompt

    Scenario: Without the grant nothing is applied, and the remedy names the one grant
      Given pmset reports on AC power every setting the manager's power policy declares, but "sleep" as "10"
      When an applying sync holds the manager's power policy
      Then the check's summary is "MANAGER_SLEEPS_ON_POWER"
      And the check's remedy contains "manager-privilege.yml"
      And no playbook was applied

  Rule: Docker Desktop is measured against its pin and never fails the run
    The manager's services run in Docker Desktop, which no playbook installs
    and which updates itself.

    Scenario: The pin names a release and its build
      Then the Docker Desktop that mise.toml pins is named "Docker Desktop", a release number and a build number in brackets

    Scenario: The pinned release passes
      Given the Docker engine names itself as the Docker Desktop that mise.toml pins
      When the Docker Desktop of the manager is measured
      Then the check's status is "pass"

    Scenario: Another release warns
      Given the Docker engine names itself "Docker Desktop 0.0.1 (1)"
      When the Docker Desktop of the manager is measured
      Then the check's status is "warn"
      And the check's summary is "MANAGER_DOCKER_DESKTOP_DRIFT"

    Scenario: An engine that does not answer warns
      Given the Docker engine does not answer
      When the Docker Desktop of the manager is measured
      Then the check's status is "warn"
      And the check's summary is "MANAGER_DOCKER_DESKTOP_UNOBSERVED"
