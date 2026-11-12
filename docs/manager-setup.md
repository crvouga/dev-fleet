# What only a person does on the manager

Everything on the manager is declared and converged by `fleet-sync`: the
toolchain, the power policy (applied by `ansible/macos/manager.yml` on every
run), the CLI proxy, the monitoring hub and their jobs. What remains are the
steps that need a person: an identity, an approval or an administrator
password. Each is done once, and `fleet-sync` measures it afterwards with the
check named beside it.

The list is tested not to grow (`features/rules/manager-setup.feature`): a
step added here must be added there too, with the check that verifies it.

<!-- human-steps -->

| Step                                                                                                       | Why a person                          | Verified by           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------- |
| Install Docker Desktop at the release `mise.toml` pins and sign in to it                                   | A licence and an account              | `manager:docker`      |
| Sign this Mac in to Tailscale and approve it                                                               | A tailnet account and device approval | `tailscale:discovery` |
| Pass the bucket credentials (`DEVFLEET_BUCKET_*`) or save them with `fleet-state --init`                   | Credentials of an account you own     | `state:bucket`        |
| Log the manager in to Vault                                                                                | A password or an identity provider    | `auth:vault`          |
| Grant the power settings once: `ansible-playbook -e user=$(id -un) -K ansible/macos/manager-privilege.yml` | An administrator password             | `manager:power`       |

<!-- /human-steps -->

The grant lets the manager's user run exactly `pmset -c` without a password,
so later syncs never prompt. Run the same playbook with `-e grant=absent` to
remove it.
