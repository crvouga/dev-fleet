import { spawn } from 'node:child_process';
import type { CommandOptions, CommandResult, Runner } from './types';
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  StdioOptions,
} from 'node:child_process';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function terminate(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid)
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {}
}

export function runCommand(
  command: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: {
        ...(options.isolatedEnv ? {} : process.env),
        ...options.env,
        GIT_TERMINAL_PROMPT: '0',
        CI: '1',
      },
      stdio: childStdio(options.preserveOperationLock),
      windowsHide: true,
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let finished = false;
    let reason: CommandResult['reason'] = 'exit';
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok, stdout, stderr, reason });
    };
    const abort = (cause: CommandResult['reason']): void => {
      reason = cause;
      terminate(child);
      finish(false);
    };
    const timer = setTimeout(() => {
      abort('timeout');
    }, options.timeoutMs ?? 15_000);
    const capture = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        abort('overflow');
        return;
      }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => capture('stdout', chunk));
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk: string) => capture('stderr', chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      abort('missing');
    });
    child.on('close', (code) => {
      finish(code === 0 && reason === 'exit');
    });
    child.stdin.end(options.input);
  });
}

/** Keep the shell-owned flock in descendants if their JS parent dies. */
export const runLockedCommand: Runner = (command, options = {}) =>
  runCommand(command, { ...options, preserveOperationLock: true });

function childStdio(preserveLock: boolean | undefined): StdioOptions {
  return preserveLock
    ? [
        'pipe',
        'pipe',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        9,
      ]
    : ['pipe', 'pipe', 'pipe'];
}
