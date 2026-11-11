import { Chalk } from 'chalk';
import ora, { type Ora } from 'ora';
import type { ManagerNode } from '../manager-sync';
import { blocking } from '../types';
import { duration } from './fleet-sync-output';

/** Live progress on stderr. A terminal gets one spinner with an elapsed timer
 * and a persisted line per finished step; anything else (pipes, CI, agents)
 * gets timestamped lines plus a heartbeat each minute, never color.
 */
export interface SyncProgress {
  step(node: string, phase: string): void;
  finished(node: ManagerNode): void;
  stop(): void;
}

export function syncProgress(
  enabled: boolean,
  stream: NodeJS.WriteStream = process.stderr
): SyncProgress {
  if (!enabled) return { step() {}, finished() {}, stop() {} };
  const live =
    Boolean(stream.isTTY) &&
    process.env['NO_COLOR'] === undefined &&
    process.env['TERM'] !== 'dumb' &&
    !process.env['CI'];
  return live ? spinnerProgress(stream) : lineProgress(stream);
}

function spinnerProgress(stream: NodeJS.WriteStream): SyncProgress {
  const c = new Chalk({ level: 1 });
  let spinner: Ora | null = null;
  let label = '';
  let started = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const text = () => `${label}  ${c.dim(duration(Date.now() - started))}`;
  const settle = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (spinner?.isSpinning)
      spinner.stopAndPersist({
        symbol: c.dim('›'),
        text: c.dim(`${label}  ${duration(Date.now() - started)}`),
      });
    spinner = null;
  };
  return {
    step(node, phase) {
      settle();
      label = `${c.bold(node)}  ${phase}`;
      started = Date.now();
      spinner = ora({ text: text(), stream, discardStdin: false }).start();
      timer = setInterval(() => {
        if (spinner) spinner.text = text();
      }, 1000);
    },
    finished(node) {
      settle();
      const failing = node.checks.filter(blocking).length;
      const warnings = node.checks.filter((c) => c.status === 'warn').length;
      const detail = [
        failing ? c.red(`${failing} failing`) : '',
        warnings ? c.yellow(`${warnings} warnings`) : '',
      ]
        .filter(Boolean)
        .join(c.dim(', '));
      const symbol = failing
        ? c.red('✖')
        : warnings
          ? c.yellow('▲')
          : c.green('✔');
      stream.write(
        `${symbol} ${c.bold(node.node)}  ${detail || c.green('ready')}  ${c.dim(duration(node.durationMs))}\n`
      );
    },
    stop: settle,
  };
}

function lineProgress(stream: NodeJS.WriteStream): SyncProgress {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stamp = () => new Date().toISOString().slice(11, 19);
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    step(node, phase) {
      clear();
      const started = Date.now();
      stream.write(`${stamp()} ${node} ${phase}\n`);
      timer = setInterval(
        () =>
          stream.write(
            `${stamp()} ${node} still ${phase.toLowerCase()} (${duration(Date.now() - started)})\n`
          ),
        60_000
      );
    },
    finished(node) {
      clear();
      const failing = node.checks.filter(blocking).length;
      stream.write(
        `${stamp()} ${node.node} ${failing ? `FAIL ${failing} failing` : 'DONE'} (${duration(node.durationMs)})\n`
      );
    },
    stop: clear,
  };
}
