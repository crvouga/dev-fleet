import type { Report } from '../types';
import { stableUrls } from './fleet-sync-output';

/** The human command answers what remains; the JSON contract retains all evidence. */
export function workerHealthText(
  report: Report,
  scope: { computers: number; excludedUnmanaged: string[] },
  dashboardUrl: string | null = null
): string {
  const lines = [
    `Fleet health: ${report.ok ? 'ready' : 'attention required'}`,
    `Scope: ${scope.computers} canonical workers; ${scope.excludedUnmanaged.length} other computers outside worker scope.`,
    `Dashboard: ${dashboardUrl ?? 'unavailable; see the dashboard checks below'}`,
  ];
  for (const node of report.nodes) {
    if (
      node.node === 'tailscale' &&
      node.checks.every((check) => check.status === 'pass')
    )
      continue;
    const gaps = node.checks.filter(
      (check) => check.required !== false && check.status !== 'pass'
    );
    lines.push(
      '',
      `${node.node}: ${gaps.length ? `${gaps.length} remaining` : 'ready'}`
    );
    for (const check of gaps) {
      lines.push(
        `  ${check.status.toUpperCase()} ${check.id}: ${check.summary}`
      );
      if (check.remedy) lines.push(`    Next: ${check.remedy.action}`);
    }
  }
  lines.push('', 'Use --json for the full versioned evidence report.');
  return stableUrls(lines.join('\n'));
}
