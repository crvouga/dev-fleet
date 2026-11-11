import type { CommandResult } from '../../src/types';
import { failed, succeeded } from './commands';

/** How a feature writes what a command answers:
 *
 *     succeeds                the command exits 0 and prints nothing
 *     prints TEXT             it exits 0 with TEXT on standard output
 *     fails                   it exits non-zero and prints nothing
 *     fails printing TEXT     it exits non-zero with TEXT on standard output
 *     fails saying TEXT       it exits non-zero with TEXT on standard error
 *
 * TEXT is taken as written; `\n` is a new line and `\t` a tab.
 */
export const ANSWER =
  '(succeeds|fails|(?:prints|fails printing|fails saying) [\\s\\S]+)';

const FORMS: [RegExp, (text: string) => CommandResult][] = [
  [/^succeeds$/, () => succeeded()],
  [/^fails$/, () => failed()],
  [/^prints ([\s\S]+)$/, (text) => succeeded(text)],
  [/^fails printing ([\s\S]+)$/, (text) => ({ ...failed(), stdout: text })],
  [/^fails saying ([\s\S]+)$/, (text) => failed(text)],
];

export function answer(written: string): CommandResult {
  for (const [form, result] of FORMS) {
    const match = form.exec(written);
    if (match)
      return result(
        (match[1] ?? '').replaceAll('\\n', '\n').replaceAll('\\t', '\t')
      );
  }
  throw new Error(`Not a way to say what a command answers: ${written}`);
}

/** Text as a feature writes it, matched whole. `…` stands for any text, so a
 * long or changing part (a temporary path, a script, a query) need not be
 * spelled out.
 */
export function wording(written: string): (text: string) => boolean {
  if (!written.includes('…')) return (text) => text === written;
  const pattern = new RegExp(
    '^' +
      written
        .split('…')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*') +
      '$'
  );
  return (text) => pattern.test(text);
}

/** A command line as a feature writes it: its arguments joined by spaces. */
export function commandLine(written: string): (command: string[]) => boolean {
  const matches = wording(written);
  return (command) => matches(command.join(' '));
}
