import { join } from 'node:path';
import type { Standing } from '../state/sync';
import type { Runner } from '../types';

/** A tool whose pin changes between the applied and the selected revision. */
export interface ToolChange {
  tool: string;
  from: string | null;
  to: string | null;
}

/** Something a sync restarts, and whether that ends work in progress. */
export interface Restart {
  service: string;
  reason: string;
  endsRunningTurns: boolean;
}

/** What `fleet-sync --dry-run` says a sync would change. It is read from
 * Git (the two revisions' tool pins and the files between them) and the
 * fleet state; nothing on a machine is changed to find it out.
 */
export interface SyncPlan {
  /** How the fleet state stood with the bucket when the plan was made. */
  state: Standing;
  revision: { from: string | null; to: string };
  /** False when the applied revision could not be read: the changes are
   * then unknown, not absent.
   */
  known: boolean;
  tools: ToolChange[];
  restarts: Restart[];
  nodes: { node: string; from: string | null; to: string; changes: boolean }[];
}

/** The coding agents' CLIs: a new version is used by the next session, and a
 * running one keeps the binary it started with.
 */
const AGENT_TOOLS = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'aqua:anomalyco/opencode',
  'http:grok',
  'http:antigravity',
];

function section(text: string, name: string): string {
  const start = text.search(new RegExp(`^\\[${name}\\]\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The exact pins under [tools], and T3's under [vars]. */
export function pins(miseToml: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of section(miseToml, 'tools').split('\n')) {
    const match =
      /^\s*"?([A-Za-z0-9@:/._-]+)"?\s*=\s*(?:"([^"]+)"|\{.*?\bversion\s*=\s*"([^"]+)")/.exec(
        line
      );
    if (match) found.set(match[1]!, (match[2] ?? match[3])!);
  }
  const t3 = /^\s*t3_version\s*=\s*"([^"]+)"/m.exec(section(miseToml, 'vars'));
  if (t3) found.set('t3', t3[1]!);
  return found;
}

export function toolChanges(
  before: Map<string, string>,
  after: Map<string, string>
): ToolChange[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names
    .filter((tool) => before.get(tool) !== after.get(tool))
    .map((tool) => ({
      tool,
      from: before.get(tool) ?? null,
      to: after.get(tool) ?? null,
    }));
}

/** What restarts follow from the changes, as the playbooks and the toolchain
 * setup act on them.
 */
export function restarts(tools: ToolChange[], files: string[]): Restart[] {
  const found: Restart[] = [];
  if (tools.some((change) => change.tool === 't3'))
    found.push({
      service: 't3',
      reason:
        'T3 is upgraded and restarted on every machine; its running agent turns end.',
      endsRunningTurns: true,
    });
  else if (
    files.some((file) =>
      /^(agents\/|ansible\/ubuntu\/(t3-policy\.yml|t3\/))/.test(file)
    )
  )
    found.push({
      service: 't3',
      reason:
        'The managed T3 policy may change: a T3 that has not loaded it is restarted, and its running agent turns end.',
      endsRunningTurns: true,
    });
  const agents = tools.filter((change) => AGENT_TOOLS.includes(change.tool));
  if (agents.length)
    found.push({
      service: 'agent-clis',
      reason: `New sessions use the new ${agents.map((change) => change.tool).join(', ')}; running turns keep the version they started with.`,
      endsRunningTurns: false,
    });
  return found;
}

async function read(
  run: Runner,
  cwd: string,
  args: string[]
): Promise<string | null> {
  const result = await run(['git', ...args], { cwd, timeoutMs: 20_000 });
  return result.ok ? result.stdout : null;
}

/** Read-only: the plan of a sync from `from` (the revision the fleet last
 * applied) to `to`. Git objects come from the checkout this runs in or the
 * manager's cache of the source repository; nothing is fetched.
 */
export async function syncPlan(
  input: {
    from: string | null;
    to: string;
    state: Standing;
    nodes: string[];
    sources: string[];
  },
  run: Runner
): Promise<SyncPlan> {
  let changes: { tools: ToolChange[]; files: string[] } | null =
    input.from === input.to ? { tools: [], files: [] } : null;
  for (const cwd of input.from && !changes ? input.sources : []) {
    const before = await read(run, cwd, ['show', `${input.from}:mise.toml`]);
    const after = await read(run, cwd, ['show', `${input.to}:mise.toml`]);
    const files = await read(run, cwd, [
      'diff',
      '--name-only',
      input.from!,
      input.to,
    ]);
    if (before === null || after === null || files === null) continue;
    changes = {
      tools: toolChanges(pins(before), pins(after)),
      files: files.split('\n').filter(Boolean),
    };
    break;
  }
  const differs = input.from !== input.to;
  return {
    state: input.state,
    revision: { from: input.from, to: input.to },
    known: changes !== null,
    tools: changes?.tools ?? [],
    restarts: changes ? restarts(changes.tools, changes.files) : [],
    nodes: input.nodes.map((node) => ({
      node,
      from: input.from,
      to: input.to,
      changes: differs,
    })),
  };
}

export const planSources = (workspace: string, root: string): string[] => [
  workspace,
  join(root, 'source'),
];

/** The plan, for people: one line per change. */
export function planText(plan: SyncPlan): string {
  const short = (revision: string | null) => revision?.slice(0, 12) ?? 'none';
  const lines = [
    plan.revision.from === plan.revision.to
      ? `Plan: the fleet stays at ${short(plan.revision.to)}.`
      : `Plan: ${short(plan.revision.from)} → ${short(plan.revision.to)} on ${plan.nodes.map((node) => node.node).join(', ') || 'no machine'}.`,
  ];
  if (!plan.known)
    lines.push(
      '  The applied revision is not in a local repository: tool and restart changes are unknown.'
    );
  for (const change of plan.tools)
    lines.push(
      `  ${change.tool} ${change.from ?? 'not installed'} → ${change.to ?? 'removed'}`
    );
  for (const restart of plan.restarts)
    lines.push(`  Restarts ${restart.service}: ${restart.reason}`);
  return lines.join('\n');
}
