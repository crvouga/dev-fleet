import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefinitionError,
  parseDefinition,
  type DefinitionProblem,
  type FleetDefinition,
} from '../definition';
import { FleetUsageError } from '../errors';
import { PACKAGE_ROOT } from '../package-info';
import { ansibleCommand } from '../platform/ansible';
import { runCommand } from '../runner';
import type { Check, Runner } from '../types';
import type { CommandOutcome } from './contracts';

export interface FleetValidateOptions {
  file?: string;
  ansible?: boolean;
  json?: boolean;
}

export interface FleetValidateServices {
  run: Runner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The package's Ansible playbooks, relative to `root`. */
  root: string;
}

const SERVICES: FleetValidateServices = {
  run: runCommand,
  env: process.env,
  platform: process.platform,
  root: PACKAGE_ROOT,
};

/** The playbooks a definition must be able to drive, in the package. */
const PLAYBOOK_DIRECTORIES = ['ansible/ubuntu', 'ansible/macos'];

/** The Ansible inventory a definition describes: the manager, and every
 * worker in the `workers` group in the order it is declared. Host names are
 * the fleet ids; a machine is reached as fleet-sync reaches it.
 */
export function fleetInventory(definition: FleetDefinition): unknown {
  const workers = Object.fromEntries(
    definition.workers.map((worker) => [
      worker.id,
      {
        ansible_host: worker.ssh,
        ...(worker.network
          ? {
              ansible_user: worker.network.user,
              ansible_port: worker.network.sshPort,
            }
          : {}),
      },
    ])
  );
  return {
    all: {
      children: {
        manager: {
          hosts: {
            [definition.manager.id]: {
              ansible_connection: 'local',
              ansible_user: definition.manager.network.user,
            },
          },
        },
        workers: { hosts: workers },
      },
    },
  };
}

/** Reads and judges one fleet.json. Nothing is contacted: with `--ansible`
 * the pinned Ansible renders the inventory and checks the playbooks' syntax
 * on this machine.
 */
export async function fleetValidate(
  options: FleetValidateOptions,
  services: FleetValidateServices = SERVICES
): Promise<CommandOutcome> {
  const path = options.file ?? services.env['DEVFLEET_CONFIG'];
  if (!path)
    throw new FleetUsageError(
      'No fleet configuration to validate. Run devfleet from the project that holds your fleet.json, or pass --file PATH.'
    );
  let definition: FleetDefinition;
  try {
    definition = parseDefinition(await readJson(path));
  } catch (error) {
    if (error instanceof DefinitionError) return invalid(path, error.problem);
    throw error;
  }
  const checks: Check[] = [
    {
      id: 'definition:schema',
      status: 'pass',
      summary: `${path} is a valid fleet definition: a manager and ${definition.workers.length} worker(s).`,
    },
  ];
  if (options.ansible)
    checks.push(...(await ansibleChecks(definition, services)));
  const ok = checks.every((check) => check.status !== 'fail');
  return {
    exitCode: ok ? 0 : 1,
    data: { version: 1, command: 'fleet-validate', ok, path, checks },
    text: checks
      .map(
        (check) => `${check.status.toUpperCase()} ${check.id}: ${check.summary}`
      )
      .join('\n'),
  };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new DefinitionError({
      code: 'DEFINITION_UNREADABLE',
      path: '$',
      expected: 'a readable file',
      actual: 'no file',
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DefinitionError({
      code: 'DEFINITION_UNREADABLE',
      path: '$',
      expected: 'JSON',
      actual: 'text that is not JSON',
    });
  }
}

function invalid(path: string, problem: DefinitionProblem): CommandOutcome {
  const data = {
    version: 1,
    command: 'fleet-validate',
    ok: false,
    path,
    problem,
  };
  return {
    exitCode: 1,
    data,
    text: `${problem.code} at ${problem.path}: expected ${problem.expected}, found ${problem.actual}.`,
  };
}

/** Renders the inventory, lists it with `ansible-inventory` and checks the
 * syntax of every playbook against it.
 */
async function ansibleChecks(
  definition: FleetDefinition,
  services: FleetValidateServices
): Promise<Check[]> {
  const directory = await mkdtemp(join(tmpdir(), 'devfleet-validate-'));
  const inventory = join(directory, 'inventory.json');
  try {
    await writeFile(inventory, JSON.stringify(fleetInventory(definition)), {
      mode: 0o600,
    });
    const playbook = ansibleCommand(services.platform, services.root);
    const tool = (name: string) => [...playbook.slice(0, -1), name];
    const listed = await services.run(
      [...tool('ansible-inventory'), '-i', inventory, '--list'],
      { timeoutMs: 120_000 }
    );
    const checks: Check[] = [
      listed.ok
        ? {
            id: 'definition:inventory',
            status: 'pass',
            summary: 'Ansible reads the inventory the definition describes.',
          }
        : {
            id: 'definition:inventory',
            status: 'fail',
            summary: 'DEFINITION_INVENTORY_REJECTED',
            remedy: {
              action:
                'Run devfleet fleet-validate --ansible on the manager after fleet-sync installed the pinned Ansible; report the failure as an issue if it persists.',
            },
          },
    ];
    const failed: string[] = [];
    for (const file of await playbooks(services.root)) {
      const result = await services.run(
        [
          ...playbook,
          '-i',
          inventory,
          '--syntax-check',
          join(services.root, file),
        ],
        { timeoutMs: 120_000 }
      );
      if (!result.ok) failed.push(file);
    }
    checks.push(
      failed.length
        ? {
            id: 'definition:playbooks',
            status: 'fail',
            summary: `DEFINITION_PLAYBOOK_SYNTAX: ${failed.join(', ')}`,
            remedy: {
              action:
                'The installed dev-fleet package carries a playbook Ansible cannot parse; report it as an issue.',
            },
          }
        : {
            id: 'definition:playbooks',
            status: 'pass',
            summary: 'Every playbook passes ansible-playbook --syntax-check.',
          }
    );
    return checks;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Every top-level playbook the fleet applies, sorted. */
async function playbooks(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const directory of PLAYBOOK_DIRECTORIES) {
    const entries = await readdir(join(root, directory)).catch(() => []);
    for (const entry of entries)
      if (entry.endsWith('.yml')) found.push(join(directory, entry));
  }
  return found.sort();
}
