import { spawn } from 'node:child_process';
import type { FleetDefinition } from '../definition';
import { shellQuote, sshArgs } from '../ssh';
import type { FleetNode } from '../types';
import type { CommandOutcome } from './contracts';
import type { FleetSyncOptions } from './fleet-sync';

/** Set on the manager side of a hand-off (and in tests): never hand off again. */
export const NO_FORWARD_ENV = 'PERSONAL_FLEET_NO_FORWARD';

/** Streams the remote command: progress on stderr, the report on stdout. */
export type ForwardSpawn = (
  command: string[]
) => Promise<{ exitCode: number; stdout: string }>;

export function forwardingDisabled(): boolean {
  return Boolean(process.env[NO_FORWARD_ENV]);
}

/** fleet-sync only ever runs on the manager. Started on a worker, it hands the
 * same request to the manager over host-key-verified SSH (no agent forwarding,
 * no credentials copied) and reports the manager's result unchanged.
 */
export async function forwardToManager(
  definition: FleetDefinition,
  options: FleetSyncOptions,
  revision: string | undefined,
  remote: { spawn?: ForwardSpawn | undefined; script?: string | null } = {}
): Promise<CommandOutcome> {
  // A test must inject the spawn: it can never reach the real manager.
  if (!remote.spawn && process.env['NODE_ENV'] === 'test')
    throw new Error('FLEET_FORWARD_IN_TEST');
  const spawnRemote = remote.spawn ?? spawnInherited;
  const runScript = remote.script ?? null;
  const { manager } = definition;
  process.stderr.write(
    `fleet-sync runs on the manager; handing off to ${manager.id} over SSH…\n`
  );
  const result = await spawnRemote(
    managerCommand(definition, options, revision, runScript)
  );
  const stdout = result.stdout.trim();
  if (options.json) {
    try {
      return { exitCode: result.exitCode, data: JSON.parse(stdout) as unknown };
    } catch {
      /* Fall through to the structured failure below. */
    }
  }
  if (result.exitCode === 255 && !stdout)
    return {
      exitCode: 1,
      data: {
        version: 1,
        ok: false,
        code: 'FLEET_MANAGER_UNREACHABLE',
        error: `Could not reach the manager (${manager.id}) over SSH. Wake it, check Tailscale and SSH (Remote Login), or run fleet-sync on the manager directly.`,
      },
    };
  return {
    exitCode: result.exitCode,
    data: { version: 1, forwardedTo: manager.id, exitCode: result.exitCode },
    text: stdout,
  };
}

/** With the revision's tracked `fleet-manager-run.sh`, the manager runs
 * fleet-sync from a clean checkout of that exact revision; otherwise (no
 * revision, or an older one without the script) its installed launcher.
 */
export function managerCommand(
  definition: FleetDefinition,
  options: FleetSyncOptions,
  revision: string | undefined,
  runScript: string | null = null
): string[] {
  const { manager } = definition;
  const target: FleetNode = {
    id: manager.id,
    ssh: `${manager.network.user}@${manager.network.tailscaleName}`,
    workspace: '~',
    required: [],
  };
  const args =
    runScript && revision
      ? [
          'sh',
          '-c',
          runScript,
          'fleet-manager-run',
          revision,
          ...forwardedFlags(options, undefined),
        ]
      : ['devfleet', 'fleet-sync', ...forwardedFlags(options, revision)];
  const color = process.stdout.isTTY && !process.env['NO_COLOR'];
  // A login shell gives the manager's normal PATH (mise, Docker, Tailscale).
  const script = `export ${NO_FORWARD_ENV}=1${color ? ' FORCE_COLOR=1' : ''}; exec ${args.map(shellQuote).join(' ')}`;
  return [...sshArgs(target), `exec /bin/zsh -lc ${shellQuote(script)}`];
}

export function forwardedFlags(
  options: FleetSyncOptions,
  revision: string | undefined
): string[] {
  const flags = revision ? ['--revision', revision] : [];
  for (const node of options.node ?? []) flags.push('--node', node);
  if (options.canary) flags.push('--canary', options.canary);
  if (options.schedule) flags.push('--schedule', options.schedule);
  const switches: [boolean | undefined, string][] = [
    [options.all, '--all'],
    [options.vaultPasswordLogin, '--vault-password-login'],
    [options.dryRun, '--dry-run'],
    [options.apply, '--apply'],
    [options.yes, '--yes'],
    [options.json, '--json'],
    [options.nonInteractive, '--non-interactive'],
    [options.maintenanceReboot, '--maintenance-reboot'],
    [options.force, '--force'],
  ];
  for (const [on, flag] of switches) if (on) flags.push(flag);
  return flags;
}

function spawnInherited(
  command: string[]
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ exitCode: 255, stdout: '' }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}
