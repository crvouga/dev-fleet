import { record, text } from './ui-data';
import type { Session } from './ui-types';

export function showRepairs(
  session: Session,
  data: Record<string, unknown>
): void {
  const catalog = data['command'] === 'repairs';
  const entries = data[catalog ? 'recipes' : 'steps'];
  if (!Array.isArray(entries)) return;
  const steps = entries.filter(record);
  session.display.table(
    ['Computer / owner', 'Repair', 'Execution'],
    steps
      .slice(0, 15)
      .map((step) => [
        text(step[catalog ? 'owner' : 'node']),
        text(step['title']),
        step['automatic'] === true && (catalog || step['eligible'] === true)
          ? 'Owner command after explicit apply'
          : 'Operator action; inspect instructions',
      ])
  );
  if (steps.length > 15)
    session.display.write(
      `Showing 15 of ${steps.length} repair entries. Inspect structured details for the complete plan and native login commands.`
    );
  if (!catalog)
    session.display.write(
      data['applied'] === true
        ? `Owner commands completed: ${text(data['completed'])}. Fresh health verified: ${data['healthOk'] === true ? 'yes' : 'no; review remaining checks'}.`
        : 'Preview only. Review the repair effects and native login instructions in structured details before applying.'
    );
}
