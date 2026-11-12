import { expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand } from '../../../src/runner';
import { monitoring } from './world';

/** The manager's container watchdog against a real container on the host's
 * Docker: frozen with SIGSTOP, so it keeps its port and answers nothing.
 */
const { Given, When, Then } = monitoring;

const root = resolve(import.meta.dir, '../../..');
const WATCHDOG = join(root, 'ansible/monitoring/container-watchdog.py');
// The image the worker's Docker smoke test already pins.
const policy = (await import('../../../ansible/ubuntu/policy.json')).default;
const IMAGE = policy.dockerSmokeTest.image;

interface Watched {
  container: string;
  state: string;
  events: Record<string, unknown>[];
  startedAt: string;
}
let watched: Watched | undefined;

async function docker(...args: string[]): Promise<string> {
  const result = await runCommand(['docker', ...args], { timeoutMs: 120_000 });
  if (!result.ok)
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const health = (container: string) =>
  docker('inspect', '--format', '{{.State.Health.Status}}', container);

async function until(
  condition: () => Promise<boolean>,
  seconds: number
): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await condition()) return true;
    await Bun.sleep(1000);
  }
  return false;
}

const need = (): Watched => {
  if (!watched) throw new Error('No watched container');
  return watched;
};

Given(
  'a labelled container that serves HTTP and checks its health every second',
  async (world) => {
    const container = `fleet-watchdog-${process.pid}-${Date.now()}`;
    const directory = await mkdtemp(join(tmpdir(), 'fleet-watchdog-'));
    world.defer(async () => {
      await runCommand(['docker', 'rm', '-f', container]);
      await rm(directory, { recursive: true, force: true });
      watched = undefined;
    });
    await docker(
      'run',
      '-d',
      '--name',
      container,
      '--label',
      'dev.devfleet.watchdog=restart',
      '--health-cmd',
      'wget -q -T 1 -O /dev/null http://127.0.0.1:8080/ || exit 1',
      '--health-interval',
      '1s',
      '--health-timeout',
      '2s',
      '--health-retries',
      '2',
      IMAGE,
      'sh',
      '-c',
      // A page to serve (a directory without one answers 404), and httpd as
      // PID 1, so the stop below freezes the process holding the port.
      'mkdir /www && echo ok >/www/index.html && exec httpd -f -p 8080 -h /www'
    );
    expect(
      await until(async () => (await health(container)) === 'healthy', 60)
    ).toBe(true);
    watched = {
      container,
      state: join(directory, 'watchdog.json'),
      events: [],
      startedAt: await docker(
        'inspect',
        '--format',
        '{{.State.StartedAt}}',
        container
      ),
    };
  }
);

Given('the container was frozen with SIGSTOP', async () => {
  // From the host, so the stop reaches the container's PID 1.
  await docker('kill', '--signal', 'STOP', need().container);
});

Given('Docker reports the container unhealthy', async () => {
  const { container } = need();
  expect(
    await until(async () => (await health(container)) === 'unhealthy', 60)
  ).toBe(true);
});

Given(
  'the watchdog already restarted the container {int} times in the last hour',
  async (_world, times: number) => {
    const { container, state } = need();
    const now = Date.now() / 1000;
    await writeFile(
      state,
      JSON.stringify({
        [container]: {
          unhealthy: 0,
          restarts: Array.from({ length: times }, (_, i) => now - 60 * (i + 1)),
          capped: null,
        },
      })
    );
  }
);

When(
  'the watchdog runs every second, restarting after {int} unhealthy checks, for at most {int} seconds',
  async (_world, checks: number, seconds: number) => {
    const current = need();
    await until(async () => {
      const result = await runCommand(
        [
          'python3',
          WATCHDOG,
          '--state',
          current.state,
          '--unhealthy-checks',
          String(checks),
          '--max-restarts-per-hour',
          '3',
        ],
        { timeoutMs: 120_000 }
      );
      for (const line of result.stdout.split('\n').filter(Boolean))
        current.events.push(JSON.parse(line) as Record<string, unknown>);
      return current.events.some(
        (event) => event['event'] === 'restarted' || event['event'] === 'capped'
      );
    }, seconds);
  }
);

Then('the watchdog restarted the container', () => {
  const { container, events } = need();
  expect(events).toContainEqual(
    expect.objectContaining({ event: 'restarted', container, ok: true })
  );
});

Then('the container is running and healthy again', async () => {
  const { container, startedAt } = need();
  expect(
    await until(async () => (await health(container)) === 'healthy', 60)
  ).toBe(true);
  expect(
    await docker('inspect', '--format', '{{.State.StartedAt}}', container)
  ).not.toBe(startedAt);
});

Then(
  'the watchdog did not restart the container, and recorded it as capped',
  async () => {
    const { container, events, state } = need();
    expect(events.some((event) => event['event'] === 'restarted')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'capped', container })
    );
    const memory = JSON.parse(await readFile(state, 'utf8')) as Record<
      string,
      { capped: number | null }
    >;
    expect(memory[container]?.capped).not.toBeNull();
  }
);
