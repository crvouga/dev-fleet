import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetDefinition } from '../definition';
import { tailscalePins, ubuntuRelease } from '../platform/ubuntu-release';
import { FleetUsageError } from '../errors';
import { fleet, secret } from '../fleet-config';
import type { SecretsProvider } from '../secrets';
import {
  controlRemedy,
  fleetTailnetControl,
  loginServer,
  TailnetControlError,
  type ControlHttp,
} from '../tailnet-control';
import type { Check } from '../types';
import { generateHostKey, renderSeed, seedUserData } from '../worker-seed';
import type { CommandOutcome } from './contracts';
import {
  keyName,
  lifecycleServices,
  type NodeLifecycleServices,
} from './fleet-node-lifecycle';

export interface NodeSeedOptions {
  id?: string;
  output?: string;
  publicKey?: string;
  autoinstall?: boolean;
  apply?: boolean;
  yes?: boolean;
}

export interface NodeSeedServices extends Pick<
  NodeLifecycleServices,
  'run' | 'playbook' | 'knownHosts'
> {
  definition: () => FleetDefinition;
  secret: SecretsProvider;
  home: string;
  /** The tailnet control plane's HTTP; answered in scenarios. */
  http?: ControlHttp;
}

export function seedServices(roster: string): NodeSeedServices {
  const { run, playbook, knownHosts } = lifecycleServices(roster);
  return {
    run,
    playbook,
    knownHosts,
    definition: () => fleet,
    secret,
    home: homedir(),
  };
}

/** Writes the first-boot seed of a declared worker to a private file: the
 * seed carries a single-use auth key, so it is never printed. With --apply
 * --yes the manager pins the host key the seed installs, so the new machine
 * is trusted without a first-use step.
 */
export async function fleetNodeSeed(
  options: NodeSeedOptions,
  services: NodeSeedServices
): Promise<CommandOutcome> {
  const worker = services
    .definition()
    .workers.find((entry) => entry.id === options.id);
  if (!worker)
    throw new FleetUsageError('--id must name a worker fleet.json declares.');
  if (!options.output)
    throw new FleetUsageError(
      '--output PATH is required: the seed holds a single-use auth key and is never printed.'
    );
  const keyFile =
    options.publicKey ?? join(services.home, '.ssh/id_ed25519.pub');
  const managerKey = await readFile(keyFile, 'utf8').catch(() => {
    throw new FleetUsageError(
      `No manager public key at ${keyFile}; name one with --public-key PATH.`
    );
  });
  const tailnet = services.definition().tailnet;
  const authKey = await seedAuthKey(worker.id, services);
  const release = ubuntuRelease(services.definition().ubuntu.release);
  if (!release)
    throw new FleetUsageError(
      'fleet.json names an Ubuntu release the support matrix does not list.'
    );
  const hostKey = await generateHostKey(worker.id, services.run);
  const seed = renderSeed(
    await seedUserData({
      worker,
      managerKey,
      authKey,
      hostKey,
      tailscale: tailscalePins(release),
      codename: release.codename,
      ...(loginServer(tailnet) ? { loginServer: loginServer(tailnet)! } : {}),
    }),
    Boolean(options.autoinstall)
  );
  await writeFile(options.output, seed, { mode: 0o600 });
  const host = await keyName(worker, services.run);
  const publicKey = hostKey.public.split(' ').slice(0, 2).join(' ');
  const pin: Check =
    options.apply && options.yes
      ? (await services.playbook('macos/worker-host-key.yml', {
          host,
          pin: 'present',
          key: publicKey,
          known_hosts: services.knownHosts,
        }))
        ? {
            id: 'ssh:host-key',
            status: 'pass',
            summary: `The manager trusts the seed's host key for ${host}.`,
          }
        : {
            id: 'ssh:host-key',
            status: 'fail',
            summary: 'SSH_HOST_KEY_NOT_CHANGED',
            remedy: {
              action:
                'The pinned Ansible could not change known_hosts; run the command again.',
            },
          }
      : {
          id: 'ssh:host-key',
          status: 'skip',
          summary: `Planned: pin the seed's host key for ${host}; run again with --apply --yes.`,
        };
  return {
    exitCode: pin.status === 'fail' ? 1 : 0,
    data: {
      version: 1,
      command: 'fleet-node-seed',
      ok: pin.status !== 'fail',
      worker: worker.id,
      output: options.output,
      format: options.autoinstall ? 'autoinstall' : 'cloud-init',
      hostKey: publicKey,
      checks: [pin],
    },
    text: [
      `Wrote the ${options.autoinstall ? 'autoinstall' : 'cloud-init'} seed of ${worker.id} to ${options.output} (private; it holds a single-use auth key).`,
      `Host key: ${publicKey}`,
      `${pin.status.toUpperCase()} ${pin.id}: ${pin.summary}`,
      'Boot a stock Ubuntu image with it; once the machine is on the tailnet, add it with fleet-node-add and run devfleet fleet-sync --node ' +
        worker.id +
        '.',
    ].join('\n'),
  };
}

/** The key the seed carries: one minted for this worker by the control plane
 * fleet.json declares, or else the secret tailnet-auth-key.
 */
async function seedAuthKey(
  worker: string,
  services: NodeSeedServices
): Promise<string> {
  const config = services.definition().tailnet;
  if (config)
    try {
      const control = await fleetTailnetControl(
        config,
        services.secret,
        services.http
      );
      return (await control!.createAuthKey({ worker })).key;
    } catch (error) {
      if (!(error instanceof TailnetControlError)) throw error;
      throw new FleetUsageError(`${error.code}: ${controlRemedy(error.code)}`);
    }
  const key = await services.secret('tailnet-auth-key');
  if (!key)
    throw new FleetUsageError(
      'The secrets provider holds no tailnet-auth-key. Declare tailnet in fleet.json with the secret tailnet-admin so a key is minted per worker, or store a short-lived, single-use, tagged Tailscale auth key there first.'
    );
  return key;
}
