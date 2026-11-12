import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleet } from '../../../src/fleet-config';
import type { FleetDefinition } from '../../../src/definition';
import {
  secretsProvider,
  type SecretsConfig,
  type SecretsProvider,
} from '../../../src/secrets';
import type { Runner } from '../../../src/types';
import type { GithubPolicy } from '../../../src/github/policy';
import type { WorkflowResult } from '../../../src/github/workflow';
import { succeeded, failed } from '../../support/commands';
import { CommandWorld, commandSteps } from '../../support/command-steps';
import { steps } from '../../support/gherkin';
import { StandInGithub } from '../support/github';

export type Provider = 'env' | 'file' | 'sops' | 'vault';

export class GithubWorld extends CommandWorld {
  readonly github = new StandInGithub();
  definition: FleetDefinition = fleet;
  provider: Provider = 'env';
  /** What the secrets provider holds, by secret name (`github-token`,
   * `github-token-worker-one`).
   */
  readonly stored = new Map<string, string>();
  /** Results of the one When, by node. */
  readonly results = new Map<string, unknown>();
  readonly workflows: WorkflowResult[] = [];
  now = new Date();
  tasks: (Record<string, unknown> & { vars?: Record<string, number> })[] = [];
  policy: GithubPolicy | undefined;
  /** Every command line any node ran, GitHub's stand-in included. */
  private readonly ran: string[] = [];

  override get lines(): string[] {
    return this.ran;
  }

  /** gh and git on `node`, then the secrets tools, then what the scenario
   * says every other command answers.
   */
  runner(node: string): Runner {
    const run = this.github.runner(node, async (command, options) => {
      const line = command.join(' ');
      const sops = /^sops --decrypt --extract \["(.+)"\] /.exec(line);
      if (sops) return stored(this.stored.get(sops[1]!));
      const vault = /^vault kv get .* -field=(GITHUB_TOKEN\S*) /.exec(line);
      if (vault)
        return stored(
          this.stored.get(vault[1]!.toLowerCase().replaceAll('_', '-'))
        );
      return this.run(command, options);
    });
    return (command, options) => {
      this.ran.push(command.join(' '));
      return run(command, options);
    };
  }

  /** The fleet's secrets provider, as the node reads it. */
  async secret(node: string): Promise<SecretsProvider> {
    const run = this.runner(node);
    const command = async (argv: string[]) => {
      const result = await run(argv, { timeoutMs: 20_000 });
      return result.ok ? result.stdout : null;
    };
    if (this.provider === 'env') {
      const env: Record<string, string> = {};
      for (const [name, value] of this.stored)
        env[`DEVFLEET_SECRET_${name.toUpperCase().replaceAll('-', '_')}`] =
          value;
      return secretsProvider({ provider: 'env' }, { env });
    }
    if (this.provider === 'file') {
      const directory = await mkdtemp(join(tmpdir(), 'fleet-github-'));
      this.defer(() => rm(directory, { recursive: true, force: true }));
      for (const [name, value] of this.stored)
        await writeFile(join(directory, name), `${value}\n`);
      return secretsProvider({ provider: 'file', directory });
    }
    const config: SecretsConfig =
      this.provider === 'sops'
        ? { provider: 'sops', file: '/x/secrets.yaml' }
        : fleet.secrets;
    return secretsProvider(config, { run: command });
  }
}

const stored = (value: string | undefined) =>
  value === undefined ? failed('not found') : succeeded(`${value}\n`);

export const github = steps<GithubWorld>();
commandSteps(github);
