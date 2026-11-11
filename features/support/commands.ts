import type { CommandOptions, CommandResult, Runner } from '../../src/types';

export const succeeded = (stdout = ''): CommandResult => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit',
});
export const failed = (stderr = ''): CommandResult => ({
  ok: false,
  stdout: '',
  stderr,
  reason: 'exit',
});

type Matcher = string | RegExp | ((command: string[]) => boolean);
type Answer =
  | CommandResult
  | ((
      command: string[],
      options?: CommandOptions
    ) => CommandResult | Promise<CommandResult>);

/** Stands in for every subprocess the code under test would start. A scenario
 * says what each command answers; nothing real runs, and every call is kept
 * so a step can say what was and was not run.
 */
export class Commands {
  readonly calls: { command: string[]; options?: CommandOptions }[] = [];
  private readonly answers: { matcher: Matcher; answer: Answer }[] = [];
  /** What a command nobody described answers. */
  otherwise: CommandResult = failed();

  /** The answer registered last wins, so a scenario can override its
   * background. A string matches anywhere in the command line.
   */
  answer(matcher: Matcher, answer: Answer): this {
    this.answers.unshift({ matcher, answer });
    return this;
  }

  private static matches(matcher: Matcher, command: string[]): boolean {
    if (typeof matcher === 'function') return matcher(command);
    const line = command.join(' ');
    return typeof matcher === 'string'
      ? line.includes(matcher)
      : matcher.test(line);
  }

  readonly run: Runner = async (command, options) => {
    this.calls.push(options ? { command, options } : { command });
    const found = this.answers.find(({ matcher }) =>
      Commands.matches(matcher, command)
    );
    if (!found) return this.otherwise;
    return typeof found.answer === 'function'
      ? found.answer(command, options)
      : found.answer;
  };

  /** Every recorded command line matching. */
  ran(matcher: Matcher): string[][] {
    return this.calls
      .map((call) => call.command)
      .filter((command) => Commands.matches(matcher, command));
  }
}
