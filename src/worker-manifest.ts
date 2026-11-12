import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './package-info';
import { shellQuote, sshArgs, sshFailure } from './ssh';
import type { Check, FleetNode, Runner } from './types';

/** What a worker is made of, measured: every installed package and its
 * version, the tools mise has active, and whether each always-on service is
 * enabled and running. Two workers built from the same revision have the same
 * manifest, so its digest proves a rebuild reproduces a machine, and its
 * difference from a fresh build shows what a long-lived worker gained.
 */
export interface WorkerManifest {
  version: 1;
  packages: Record<string, string>;
  tools: Record<string, string>;
  units: Record<string, string>;
}

/** The policy a worker's manifest is measured against. */
interface UbuntuPolicy {
  packages: Record<string, string>;
  alwaysOnServices: string[];
}

export async function ubuntuPolicy(root = PACKAGE_ROOT): Promise<UbuntuPolicy> {
  return JSON.parse(
    await readFile(join(root, 'ansible/ubuntu/policy.json'), 'utf8')
  ) as UbuntuPolicy;
}

/** A read-only POSIX probe: it lists, and changes nothing. */
export function manifestProbe(services: string[]): string {
  const units = services.map(shellQuote).join(' ');
  return [
    'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"',
    'echo @packages',
    "dpkg-query -W -f='${binary:Package}=${Version}\\n' 2>/dev/null",
    'echo @tools',
    "mise ls --current --json 2>/dev/null | tr -d '\\n'; echo",
    'echo @units',
    `for unit in ${units}; do printf '%s=%s/%s\\n' "$unit" "$(systemctl is-enabled "$unit" 2>/dev/null)" "$(systemctl is-active "$unit" 2>/dev/null)"; done`,
  ].join('; ');
}

const sorted = (entries: [string, string][]): Record<string, string> =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function pairs(lines: string[]): [string, string][] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)] as [string, string];
    });
}

function tools(line: string | undefined): Record<string, string> {
  try {
    const listed = JSON.parse(line ?? '{}') as Record<
      string,
      { version?: string }[]
    >;
    return sorted(
      Object.entries(listed).map(([tool, versions]) => [
        tool,
        versions
          .map((entry) => entry.version ?? '')
          .sort()
          .join(','),
      ])
    );
  } catch {
    return {};
  }
}

/** The manifest the probe printed. Order never matters: everything is sorted. */
export function parseManifest(stdout: string): WorkerManifest {
  const sections: Record<string, string[]> = {};
  let current = '';
  for (const line of stdout.split('\n')) {
    if (/^@[a-z]+$/.test(line.trim())) {
      current = line.trim().slice(1);
      sections[current] = [];
    } else if (current) sections[current]!.push(line);
  }
  return {
    version: 1,
    packages: sorted(pairs(sections['packages'] ?? [])),
    tools: tools(sections['tools']?.find((line) => line.trim())),
    units: sorted(pairs(sections['units'] ?? [])),
  };
}

/** The same manifest always has the same digest. */
export function manifestDigest(manifest: WorkerManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export interface ManifestDifference {
  section: 'packages' | 'tools' | 'units';
  name: string;
  expected: string | null;
  actual: string | null;
}

/** What `live` has that `reference` does not, lacks, or has otherwise. */
export function diffManifests(
  reference: WorkerManifest,
  live: WorkerManifest
): ManifestDifference[] {
  const differences: ManifestDifference[] = [];
  for (const section of ['packages', 'tools', 'units'] as const) {
    const names = new Set([
      ...Object.keys(reference[section]),
      ...Object.keys(live[section]),
    ]);
    for (const name of [...names].sort()) {
      const expected = reference[section][name] ?? null;
      const actual = live[section][name] ?? null;
      if (expected !== actual)
        differences.push({ section, name, expected, actual });
    }
  }
  return differences;
}

/** Where a manifest departs from what the policy declares: a pinned package
 * at another version or missing, an always-on service not enabled and active.
 */
export function declaredDifferences(
  manifest: WorkerManifest,
  policy: UbuntuPolicy
): ManifestDifference[] {
  const differences: ManifestDifference[] = [];
  for (const [name, version] of Object.entries(policy.packages)) {
    const actual = manifest.packages[name] ?? null;
    if (actual !== version)
      differences.push({
        section: 'packages',
        name,
        expected: version,
        actual,
      });
  }
  for (const unit of policy.alwaysOnServices) {
    const actual = manifest.units[unit] ?? null;
    if (actual !== 'enabled/active')
      differences.push({
        section: 'units',
        name: unit,
        expected: 'enabled/active',
        actual,
      });
  }
  return differences;
}

/** `worker:manifest`: the worker is what a fresh build of the same revision
 * is (when a reference is given) and what the policy declares.
 */
export function manifestCheck(differences: ManifestDifference[]): Check {
  if (!differences.length)
    return {
      id: 'worker:manifest',
      status: 'pass',
      summary: 'The worker matches the declared pins and the fresh build.',
    };
  const shown = differences
    .slice(0, 20)
    .map(
      (difference) =>
        `${difference.section}:${difference.name} ${difference.expected ?? 'absent'} -> ${difference.actual ?? 'absent'}`
    );
  return {
    id: 'worker:manifest',
    status: 'fail',
    summary: `WORKER_MANIFEST_DRIFT: ${differences.length} difference(s): ${shown.join('; ')}`,
    remedy: {
      action:
        'Something was installed, removed or changed outside fleet-sync. Rebuild the worker (fleet-node-replace) or declare the change in dev-fleet.',
    },
  };
}

/** Measures one worker's manifest over the verified SSH connection. */
export async function measureManifest(
  node: FleetNode,
  run: Runner,
  policy: UbuntuPolicy
): Promise<{ manifest: WorkerManifest } | { check: Check }> {
  const result = await run(
    [...sshArgs(node), manifestProbe(policy.alwaysOnServices)],
    { timeoutMs: 60_000 }
  );
  if (!result.ok) return { check: sshFailure(result) };
  return { manifest: parseManifest(result.stdout) };
}
