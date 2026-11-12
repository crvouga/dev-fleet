import { resolveVaultConfig, usesVault } from './vault-config';
import { fleet as definition } from './fleet-config';
import { workerReadiness } from './worker-readiness';
import { record } from './config';
import { codingAuth, serviceAuth } from './service-auth';
import { workstationChecks } from './workstation-checks';
import { toolchainChecks } from './toolchain-checks';
import { workerSelection } from '../bootstrap/worker-tools';
import type { Capability, Check, Runner, CommandResult } from './types';

export async function authCheck(
  capability: Capability,
  run: Runner,
  root: string,
  nodeId?: string
): Promise<Check[]> {
  if (capability === 'worker') return workerReadiness(run, nodeId, root);
  if (capability === 't3') return t3Checks(run, nodeId !== undefined);
  if (capability === 'codex' || capability === 'claude')
    return codingAuth(capability, run);
  if (capability === 'services') return serviceAuth(run);
  if (capability === 'workstation') return workstationChecks(root, run);
  if (capability === 'toolchain')
    return toolchainChecks(
      root,
      run,
      definition.workers.some((node) => node.id === nodeId)
        ? workerSelection(definition, nodeId)
        : undefined
    );
  return basicAuth(capability, run, root);
}

async function basicAuth(
  capability: 'github' | 'vault' | 'vscode',
  run: Runner,
  root: string
): Promise<Check[]> {
  const spec = {
    github: {
      command: ['gh', 'auth', 'status', '--active'],
      action:
        'Authenticate on this node with gh auth login, then gh auth setup-git.',
    },
    vault: {
      command: [
        'vault',
        'token',
        'lookup',
        '-format=json',
        `-address=${usesVault() ? resolveVaultConfig().addr : ''}`,
      ],
      action:
        'Authenticate to the configured Vault on this node. Do not copy a token from another computer.',
    },
    vscode: {
      command: ['code', '--list-extensions'],
      action:
        'Install the VS Code CLI on PATH and ms-vscode-remote.remote-ssh in the local editor profile.',
    },
  }[capability];
  const result = await run(spec.command, {
    cwd: root,
    timeoutMs: 15_000,
  });
  const extensions = result.stdout.toLowerCase().split(/\s+/);
  const ok =
    result.ok &&
    (capability !== 'vscode' ||
      extensions.includes('ms-vscode-remote.remote-ssh'));
  return [
    {
      id: `auth:${capability}`,
      status: ok ? 'pass' : 'fail',
      summary: ok
        ? `${capability} check succeeded in this process context.`
        : `${capability} check failed (${result.reason}); no credential output retained.`,
      ...(ok ? {} : { remedy: { action: spec.action } }),
    },
  ];
}

async function t3Checks(
  run: Runner,
  managerChecksLinks = false
): Promise<Check[]> {
  const t3 = await t3Executable(run);
  const config = await run([t3, 'status', '--json']);
  const checks: Check[] = [t3Settings(config)];
  const live = await run([t3, 'environment', 'list', '--json']);
  checks.push({
    id: 't3:api',
    status: live.ok ? 'pass' : 'fail',
    summary: live.ok
      ? 'Local T3 API answered a read-only environment listing; peer connectivity is not inferred.'
      : 'Local T3 API did not answer the environment listing.',
    ...(!live.ok
      ? {
          remedy: {
            action:
              'Check t3 service status and t3 status. Inspect linked peers in T3 Settings → Connections; relink only with operator approval.',
          },
        }
      : {}),
  });
  if (!managerChecksLinks)
    checks.push({
      id: 't3:end-to-end',
      status: 'skip',
      summary:
        'Relay traversal and remote peer authorization require an operator connection test; local settings are not proof.',
    });
  return checks;
}

/** Workers run only the T3 desktop app, so no `t3` launcher need be on PATH.
 * Fall back to the newest pinned native CLI the shared installer verified.
 */
async function t3Executable(run: Runner): Promise<string> {
  const found = await run(
    [
      'sh',
      '-c',
      'command -v t3 || ls -d "$HOME"/.local/share/personal/tools/t3-*/t3 2>/dev/null | sort -V | tail -n 1',
    ],
    { timeoutMs: 5000 }
  );
  const path = found.ok ? (found.stdout.trim().split('\n').pop() ?? '') : '';
  return /^\/[\x21-\x7e]+$/.test(path) ? path : 't3';
}

function t3Settings(config: CommandResult): Check {
  const fallback: Check = {
    id: 't3:settings',
    status: 'fail',
    summary: 'T3 settings unavailable or unsupported CLI response.',
    remedy: {
      action:
        'Run t3 status --json on this node. Complete t3 up --connect as its operator if needed.',
    },
  };
  try {
    const data: unknown = JSON.parse(config.stdout);
    if (config.ok && record(data) && record(data['connect'])) {
      const enabled =
        data['connect']['enabled'] === true &&
        data['connect']['revoked'] === false;
      return {
        id: 't3:settings',
        status: enabled ? 'pass' : 'fail',
        summary: enabled
          ? 'T3 Connect enabled and not marked revoked (settings only).'
          : 'T3 Connect disabled, revoked, or unknown.',
        ...(!enabled
          ? {
              remedy: {
                action:
                  'Review t3 status, then complete t3 up --connect as the operator. Never share pairing tokens.',
              },
            }
          : {}),
      };
    }
  } catch {}
  return fallback;
}
