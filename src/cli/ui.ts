import type { InteractiveOptions } from './contracts';
import { runInteractive } from './ui-controller';
import { terminalDisplay, terminalPrompts } from './ui-terminal';

export async function startInteractive(
  options: InteractiveOptions
): Promise<void> {
  await runInteractive(options, terminalPrompts(), terminalDisplay());
}
