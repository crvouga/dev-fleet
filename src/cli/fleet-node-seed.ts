import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetDefinition } from '../definition';
import { ubuntuRelease } from '../platform/ubuntu-release';
import { FleetUsageError } from '../errors';
import { fleet, secret } from '../fleet-config';
import type { SecretsProvider } from '../secrets';
import type { Check } from '../types';
import {
  generateHostKey,
  renderSeed,
  seedUserData,
  tailscalePins,
} from '../worker-seed';
import type { CommandOutcome } from './contracts';
import {
  keyName,
  lifecycleServices,
  pinHostKey,
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
  'run' | 'playbook' | 'knownHosts' | 'state' | 'now'
> {
  definition: () => FleetDefinition;
  secret: SecretsProvider;
  home: string;
}

export function seedServices(roster: string): NodeSeedServices {
  const { run, playbook, knownHosts, state, now } = lifecycleServices(roster);
  return {
    run,
    playbook,
    knownHosts,
    state,
    now,
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
  const authKey = await services.secret('tailnet-auth-key');
  if (!authKey)
    throw new FleetUsageError(
      'The secrets provider holds no tailnet-auth-key. Store a short-lived, single-use, tagged Tailscale auth key there first.'
    );
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
      tailscale: await tailscalePins(),
      codename: release.codename,
    }),
    Boolean(options.autoinstall)
  );
  await writeFile(options.output, seed, { mode: 0o600 });
  const host = await keyName(worker, services.run);
  const publicKey = hostKey.public.split(' ').slice(0, 2).join(' ');
  // Pinned before the machine answers: in the fleet state for a worker
  // reached from declared data, else in the operator's known_hosts.
  const pin: Check =
    options.apply && options.yes
      ? await pinHostKey(worker, host, publicKey, services)
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
