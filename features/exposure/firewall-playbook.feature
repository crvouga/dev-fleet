Feature: The baseline closes a worker to everything but the tailnet without locking the manager out
  ansible/ubuntu/tasks/firewall.yml loads the fleet's own nftables table and
  ansible/ubuntu/tasks/ssh.yml hardens sshd. Both run on every machine,
  public address or not. What they do on a real machine is proven by the
  disposable VM test; these scenarios read what the playbooks declare.

  Rule: Inbound traffic arrives only over loopback and the tailnet

    Scenario: The input chain drops by default and admits loopback, the tailnet and tailscaled
      When the firewall rules the baseline loads are read
      Then the input chain drops what no rule accepts
      And the input chain accepts traffic on these interfaces:
        | lo         |
        | tailscale0 |
      And the input chain accepts UDP to tailscaled's port 41641
      And the SSH port is accepted beyond the tailnet only by a rule marked "public-ssh", written only when "firewall_public_ssh" holds

    Scenario: A published container port is dropped from outside the tailnet, only where Docker is installed
      When the firewall rules the baseline loads are read
      Then the forward chain is written only when "firewall_docker" holds
      And the forward chain drops connections Docker translated that arrived from outside the tailnet

    Scenario: Every worker gets the rules, but a container leaves them to its host
      When the baseline playbook is read
      Then it applies "tasks/firewall.yml" after "tasks/ssh.yml"
      And it applies "tasks/firewall.yml" unless the machine is a container

  Rule: The manager is never locked out

    Scenario: The public SSH port closes only when the session arrived over the tailnet
      When the firewall tasks are read
      Then the public SSH port stays open when any of these holds:
        | firewall_policy.publicSsh                                      |
        | not tailnet_up                                                 |
        | firewall_session_client \| length > 0 and not session_over_tailnet |
        | firewall_session_client \| length == 0 and previously_public    |

    Scenario: Closing the public path is verified with new connections over the tailnet, or rolled back
      When the firewall tasks are read
      Then one block writes the rules, loads them and then verifies, in this order:
        | Write the rules, validated by nft (FIREWALL_RULES_REJECTED)                        |
        | Load the rules                                                                     |
        | Verify the manager's tailnet path with a new probe (FIREWALL_TAILNET_UNVERIFIED)   |
        | Verify sshd accepts a new connection on the tailnet address (FIREWALL_TAILNET_UNVERIFIED) |
      And its rescue restores the previous rules, reloads them and fails with "FIREWALL_RULES_REJECTED" or "FIREWALL_TAILNET_UNVERIFIED"

  Rule: sshd takes keys only and refuses root

    Scenario: The hardening fragment sorts before the image's and is verified after reload
      When the SSH tasks are read
      Then "/etc/ssh/sshd_config.d/10-personal-fleet-exposure.conf" is written with:
        | PubkeyAuthentication yes         |
        | PasswordAuthentication no        |
        | KbdInteractiveAuthentication no  |
        | PermitEmptyPasswords no          |
        | PermitRootLogin no               |
      And a rejected configuration restores both fragments before sshd is reloaded
      And after reload "sshd -T" must show, or fail with "SSH_HARDENING_OVERRIDDEN":
        | passwordauthentication no        |
        | kbdinteractiveauthentication no  |
        | permitrootlogin no               |
