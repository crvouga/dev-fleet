import type { NodeReport, Report, Status } from './types';

export function makeReport(command: string, nodes: NodeReport[]): Report {
  const summary: Record<Status, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
    'not-applicable': 0,
  };
  for (const node of nodes)
    for (const check of node.checks) summary[check.status] += 1;
  return {
    version: 1,
    command,
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    nodes,
    summary,
  };
}

export function reportExitCode(report: Report, strict: boolean): number {
  return !report.ok ||
    (strict &&
      report.nodes.some((node) =>
        node.checks.some(
          (check) =>
            check.required !== false && ['warn', 'skip'].includes(check.status)
        )
      ))
    ? 1
    : 0;
}

export function renderReport(report: Report): string {
  const lines = [
    `Fleet ${report.command}: ${report.ok ? 'no failing checks' : 'attention needed'}`,
  ];
  for (const node of report.nodes) {
    lines.push(`\n${node.node}`);
    for (const check of node.checks) {
      lines.push(
        `  ${check.status.toUpperCase()} ${check.id}: ${check.summary}`
      );
      if (check.remedy) lines.push(`    Next: ${check.remedy.action}`);
    }
  }
  lines.push(
    `\n${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip${report.summary['not-applicable'] ? `, ${report.summary['not-applicable']} not applicable` : ''}`
  );
  return lines.join('\n');
}

export async function mapBounded<Input, Output>(
  items: Input[],
  worker: (input: Input) => Promise<Output>,
  concurrency = 4
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const consume = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, consume)
  );
  return results;
}
