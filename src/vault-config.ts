import { fleet } from './fleet-config';
import { FleetUsageError } from './errors';

export type VaultConfig = {
  addr: string;
  mount: string;
  project: string;
  config: string;
};

/** True when this fleet keeps its secrets in Vault. Only then does each node
 * hold its own Vault session, with the logins, renewal and checks that go
 * with it; the other providers need none of that.
 */
export const usesVault = (): boolean => fleet.secrets.provider === 'vault';

/** This fleet's Vault and the shared document (`<mount>/<project>/<config>`)
 * that holds the proxy client key, from its `secrets` configuration.
 */
export function resolveVaultConfig(): VaultConfig {
  const secrets = fleet.secrets;
  if (secrets.provider !== 'vault')
    throw new FleetUsageError(
      'This fleet does not use the vault secrets provider.'
    );
  const [project = '', ...rest] =
    secrets.locations['proxy-client-key'].path.split('/');
  return {
    addr: process.env['VAULT_ADDR']?.trim() || secrets.address,
    mount: secrets.mount,
    project,
    config: rest.join('/'),
  };
}

export function kvPath(vault: VaultConfig): string {
  return `${vault.mount}/data/${vault.project}/${vault.config}`;
}
