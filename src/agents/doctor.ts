import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { agentRoot } from './render';
import { registry, select } from './registry';
import { plan } from './converge';
import type { Platform } from '../platform/types';
import type { DoctorCheck } from '../doctor-check';

export async function agentChecks(platform: Platform): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [tool, definition] of Object.entries(registry.tools)) {
    const binary = Bun.which(definition.binary);
    checks.push({
      id: `agent:${tool}`,
      label: `${tool} installed`,
      severity: binary ? 'pass' : 'warn',
      detail: binary
        ? await version(definition.binary)
        : 'Not on PATH. Use shared mise for managed CLIs; desktop apps remain OS prerequisites.',
    });
  }
  const root = agentRoot(homedir(), platform.name);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let profiles = 0;
  for (const node of entries
    .filter(
      (entry) =>
        entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.name)
    )
    .slice(0, 64)) {
    for (const tool of Object.keys(registry.defaults)) {
      for (const profile of ['direct', 'proxy']) {
        const check = await profileCheck(root, node.name, tool, profile);
        if (check) {
          checks.push(check);
          profiles++;
        }
      }
    }
  }
  if (profiles === 0)
    checks.push({
      id: 'agent:profiles',
      label: 'Managed profiles',
      severity: 'warn',
      detail:
        'No applied profiles. Run bun src/agents/cli.ts agents preview --node ID, then bun src/agents/cli.ts --yes agents apply --node ID.',
    });
  return checks;
}

async function profileCheck(
  root: string,
  node: string,
  tool: string,
  profile: string
): Promise<DoctorCheck | null> {
  const receiptPath = join(root, node, tool, profile, 'receipt.json');
  if (!(await lstat(receiptPath).catch(() => null))) return null;
  try {
    const result = await plan({
      root,
      selection: select(node, tool, profile),
      revision: 'unverified',
    });
    if (!result.previous) return null;
    const clean =
      result.files.every((file) => file.state === 'unchanged') &&
      result.previous.fingerprint === result.fingerprint;
    return {
      id: `agent:${node}:${tool}:${profile}`,
      label: 'Managed profile drift',
      severity: clean ? 'pass' : 'fail',
      detail: `Applied revision ${result.previous.revision}; static configuration ${clean ? 'matches' : 'drifted'}. Secret availability, endpoint, inference and T3 end-to-end require bun src/agents/cli.ts agents verify/operator tests.`,
    };
  } catch {
    return {
      id: `agent:${node}:${tool}:${profile}`,
      label: 'Managed profile drift',
      severity: 'fail',
      detail:
        'Profile or receipt cannot be validated. Inspect locally and preview before applying; raw contents withheld.',
    };
  }
}

async function version(binary: string): Promise<string> {
  try {
    const child = Bun.spawn([binary, '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const text = await new Response(child.stdout).text();
      const match = text.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/);
      return (await child.exited) === 0 && match
        ? `Version ${match[0]}; installation pins remain owned by mise.`
        : 'Version unverified.';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'Version unverified.';
  }
}
