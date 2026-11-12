import { Chalk, type ChalkInstance } from 'chalk';
import type { ManagerNode, ManagerReport } from '../manager-sync';
import { blocking, type Check, type Status } from '../types';

/** Report columns: each owns the checks whose id matches. A check matches the
 * first column that claims it; anything unclaimed still counts in RESULT.
 */
const COLUMNS: { title: string; matches: (id: string) => boolean }[] = [
  { title: 'NET', matches: (id) => id.startsWith('tailscale:') },
  { title: 'SSH', matches: (id) => id.startsWith('ssh:') },
  {
    title: 'OS',
    matches: (id) =>
      ['ubuntu:baseline', 'configuration:apply'].includes(id) ||
      id.startsWith('manager:'),
  },
  {
    title: 'T3',
    matches: (id) =>
      [
        't3:service',
        't3:policy-staged',
        't3:policy-loaded',
        't3:running-version',
        't3:providers',
        't3:private-route',
        'worker:t3-recovery',
        'worker:t3-health',
        'worker:service-recovery',
      ].includes(id),
  },
  {
    title: 'LINK',
    matches: (id) =>
      ['t3:manager-endpoint', 't3:manager-origin', 't3:paired-access'].includes(
        id
      ),
  },
  {
    title: 'PROXY',
    matches: (id) =>
      id.startsWith('provider:') ||
      id.startsWith('proxy:') ||
      id === 'worker:proxy-singleton',
  },
  { title: 'AGENTS', matches: (id) => id.startsWith('agent:') },
  {
    title: 'MON',
    matches: (id) =>
      id.startsWith('beszel:') || id === 'worker:service:beszel-agent',
  },
];

const ORDER: Status[] = ['fail', 'warn', 'skip', 'not-applicable', 'pass'];
const WORD: Record<Status, string> = {
  fail: 'FAIL',
  warn: 'WARN',
  skip: 'SKIP',
  'not-applicable': 'N/A',
  pass: 'PASS',
};
const SYMBOL: Record<Status, string> = {
  fail: '✖',
  warn: '▲',
  skip: '○',
  'not-applicable': '–',
  pass: '✔',
};

export interface OutputOptions {
  /** Colors and symbols; plain words otherwise (pipes, NO_COLOR, agents). */
  color?: boolean;
  durationMs?: number;
  /** Where the full JSON report of this run was saved. */
  reportPath?: string;
}

/** Colors only for an interactive stdout that allows them. */
export function stdoutColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return Boolean(process.stdout.isTTY) && process.env['TERM'] !== 'dumb';
}

/** Short, stable report: one header line, a node grid, then each problem once
 * (deduplicated across nodes) with its code and fix. Every line is greppable:
 * `FAIL <check> <CODE> [nodes]` in plain mode, the same with symbols in color.
 */
export function managerText(
  report: ManagerReport,
  options: OutputOptions = {}
): string {
  const c = new Chalk({ level: options.color ? 1 : 0 });
  const mark = (status: Status | null): string =>
    status === null
      ? c.dim('·')
      : paint(c, status, options.color ? SYMBOL[status] : WORD[status]);
  const all = [
    ...report.checks.map((check) => ({ node: 'fleet', check })),
    ...report.nodes.flatMap((node) =>
      node.checks.map((check) => ({ node: node.node, check }))
    ),
  ];
  const counts = count(all.map((entry) => entry.check));
  const failing = all.some((entry) => blocking(entry.check));
  const lines: string[] = [header(c, report, failing, options)];
  lines.push('', ...grid(c, report.nodes, mark, options.color === true));
  lines.push('', totals(c, counts, options.color === true));
  for (const status of ['fail', 'warn', 'skip'] as const) {
    const problems = groupProblems(
      all.filter((entry) => entry.check.status === status)
    );
    if (!problems.length) continue;
    lines.push('', c.bold(SECTION[status]));
    for (const problem of problems)
      lines.push(...problemLines(c, problem, options.color === true));
  }
  lines.push('');
  if (report.dashboardUrl)
    lines.push(`${c.dim('dashboard')}  ${c.cyan(report.dashboardUrl)}`);
  if (options.reportPath)
    lines.push(
      `${c.dim('report   ')}  ${options.reportPath} ${c.dim('(full JSON; or rerun with --json)')}`
    );
  if (report.candidates)
    lines.push(
      `${c.dim('tailnet  ')}  ${report.candidates} unmanaged device(s) seen; discovery never enrolls them`
    );
  if (!report.applied) lines.push(c.dim('No node deployment was performed.'));
  return stableUrls(lines.join('\n'));
}

const TAILNET_URL =
  /\bhttps?:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?(?:\/[^\s'",;)]*[^\s'",;).])?/gi;

/** Printed output names only stable public URLs. A tailnet
 * MagicDNS address in any summary or remedy is replaced, never shown.
 */
export function stableUrls(text: string): string {
  return text.replace(TAILNET_URL, 'its private tailnet address');
}

const SECTION: Record<'fail' | 'warn' | 'skip', string> = {
  fail: 'Failing — fix these',
  warn: 'Warnings — outside the fleet; sync still succeeds',
  skip: 'Not observable on this hardware',
};

function header(
  c: ChalkInstance,
  report: ManagerReport,
  failing: boolean,
  options: OutputOptions
): string {
  const verdict = failing
    ? c.red.bold(`${options.color ? '✖ ' : ''}ACTION REQUIRED`)
    : report.applied
      ? c.green.bold(`${options.color ? '✔ ' : ''}CONVERGED`)
      : c.green.bold(`${options.color ? '✔ ' : ''}PREVIEW OK`);
  const parts = [
    c.bold('fleet-sync'),
    verdict,
    `${c.dim('revision')} ${(report.desiredRevision ?? 'none').slice(0, 12)}`,
  ];
  if (options.durationMs !== undefined)
    parts.push(`${c.dim('in')} ${duration(options.durationMs)}`);
  return parts.join('  ');
}

function grid(
  c: ChalkInstance,
  nodes: ManagerNode[],
  mark: (status: Status | null) => string,
  color: boolean
): string[] {
  const width = Math.max(4, ...nodes.map((node) => node.node.length));
  const cell = (text: string, visible: number, size: number) =>
    text + ' '.repeat(Math.max(1, size - visible + 1));
  const head = [
    'NODE'.padEnd(width + 1),
    'ROLE'.padEnd(8),
    ...COLUMNS.map((column) => column.title.padEnd(6)),
    'RESULT',
  ].join(' ');
  const rows = nodes.map((node) => {
    const statuses = COLUMNS.map((column) =>
      worst(node.checks.filter((check) => column.matches(check.id)))
    );
    const failing = node.checks.filter(blocking).length;
    const result =
      node.reachability !== 'online' && node.role !== 'manager'
        ? c.red(node.reachability.toUpperCase())
        : failing
          ? c.red(`${failing} failing`)
          : node.appliedRevision
            ? c.green('ready')
            : c.yellow('not applied');
    return [
      cell(c.bold(node.node), node.node.length, width),
      cell(c.dim(node.role ?? 'worker'), (node.role ?? 'worker').length, 7),
      ...statuses.map((status) =>
        cell(
          mark(status),
          status === null ? 1 : color ? 1 : WORD[status].length,
          5
        )
      ),
      result,
    ].join(' ');
  });
  return [c.dim(head), ...rows];
}

interface Problem {
  check: Check;
  nodes: string[];
}

function groupProblems(entries: { node: string; check: Check }[]): Problem[] {
  const groups = new Map<string, Problem>();
  for (const { node, check } of entries) {
    const key = [
      check.id,
      check.status,
      check.summary,
      check.remedy?.action ?? '',
    ].join('\u0000');
    const group = groups.get(key);
    if (group) group.nodes.push(node);
    else groups.set(key, { check, nodes: [node] });
  }
  return [...groups.values()];
}

function problemLines(
  c: ChalkInstance,
  { check, nodes }: Problem,
  color: boolean
): string[] {
  const { code, detail } = splitSummary(check.summary);
  const lead = paint(
    c,
    check.status,
    color ? SYMBOL[check.status] : WORD[check.status]
  );
  const lines = [
    `${lead} ${c.bold(check.id)}  ${code ? paint(c, check.status, code) : ''}${code && detail ? ' ' : ''}${detail}`.trimEnd(),
    `    ${c.dim('on')} ${nodes.join(', ')}`,
  ];
  if (check.remedy?.action)
    lines.push(`    ${c.cyan('→')} ${check.remedy.action}`);
  if (check.remedy?.command)
    lines.push(`    ${c.cyan('$')} ${check.remedy.command}`);
  return lines;
}

/** Summaries start with an UPPER_SNAKE code when there is one. */
export function splitSummary(summary: string): {
  code: string;
  detail: string;
} {
  const match = /^([A-Z][A-Z0-9_]{2,})(?:\s+(.*))?$/s.exec(summary.trim());
  return match
    ? { code: match[1]!, detail: match[2] ?? '' }
    : { code: '', detail: summary };
}

function totals(
  c: ChalkInstance,
  counts: Record<Status, number>,
  color: boolean
): string {
  // Not-applicable checks are listed only on machines that have some.
  return ORDER.filter((status) => status !== 'not-applicable' || counts[status])
    .map((status) => {
      const text = `${color ? `${SYMBOL[status]} ` : ''}${counts[status]} ${LABEL[status]}`;
      // A zero count is not a signal: never show red/yellow for "0 failing".
      return counts[status] ? paint(c, status, text) : c.dim(text);
    })
    .join(c.dim('   '));
}

const LABEL: Record<Status, string> = {
  fail: 'failing',
  warn: 'warnings',
  skip: 'skipped',
  'not-applicable': 'not applicable',
  pass: 'passing',
};

function count(checks: Check[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
    'not-applicable': 0,
  };
  for (const check of checks)
    counts[
      blocking(check) || check.status !== 'fail' ? check.status : 'warn'
    ]++;
  return counts;
}

function worst(checks: Check[]): Status | null {
  if (!checks.length) return null;
  if (checks.some(blocking)) return 'fail';
  if (
    checks.some(
      (check) =>
        check.status !== 'pass' &&
        check.status !== 'skip' &&
        check.status !== 'not-applicable'
    )
  )
    return 'warn';
  return checks.every((check) => check.status === 'skip') ? 'skip' : 'pass';
}

function paint(c: ChalkInstance, status: Status, text: string): string {
  return status === 'fail'
    ? c.red(text)
    : status === 'warn'
      ? c.yellow(text)
      : status === 'skip' || status === 'not-applicable'
        ? c.dim(text)
        : c.green(text);
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
