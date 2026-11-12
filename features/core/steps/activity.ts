import { idleCheck, type WorkerActivity } from '../../../src/worker-activity';
import { core, need, type CoreWorld } from './world';

/** Whether a worker is idle, judged from what its T3 records. */
const { Given, When } = core;

const activities = new WeakMap<CoreWorld, WorkerActivity>();

Given(
  /^a worker whose T3 (runs (?:\d+) agent turns?|cannot say what it runs), last active at "([^"]+)", up (\d+) seconds$/,
  (world, runs: string, last: string, uptime: string) => {
    const count = /runs (\d+)/.exec(runs)?.[1];
    activities.set(world, {
      uptimeSeconds: Number(uptime),
      runningSessions: count === undefined ? null : Number(count),
      lastActivityAt: last === 'never' ? null : last,
    });
  }
);

When(
  /^it is judged at "([^"]+)"(?:, with workers idle after (\d+) hours)?$/,
  (world, now: string, hours: string | null) => {
    const judged = idleCheck(
      'worker-one',
      need(world, activities.get(world), 'a worker'),
      hours == null ? undefined : Number(hours),
      new Date(now)
    );
    world.checks = [judged.check];
    world.outcome = judged.check;
  }
);
