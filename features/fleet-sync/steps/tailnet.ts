import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  fleetTailnetControl,
  parseTailnetConfig,
  type ControlRequest,
  type ControlResponse,
  type TailnetConfig,
  type TailnetDevice,
} from '../../../src/tailnet-control';
import type { DataTable } from '../../support/gherkin';
import { fleetSync, ROOT, type FleetSyncWorld } from '../support/world';

/** The tailnet control plane, answered from memory: what it was asked, and
 * what it answers.
 */
const { Given, When, Then } = fleetSync;

export interface ControlPlane {
  config?: TailnetConfig;
  /** Made per scenario, so no credential-shaped literal is committed. */
  credential: string | null;
  answer: ControlResponse;
  requests: ControlRequest[];
  key?: string;
  devices?: TailnetDevice[];
  refusal?: Error;
}
const planes = new WeakMap<FleetSyncWorld, ControlPlane>();

export function controlPlane(world: FleetSyncWorld): ControlPlane {
  let found = planes.get(world);
  if (!found) {
    found = {
      credential: null,
      answer: { status: 200, body: {} },
      requests: [],
    };
    planes.set(world, found);
  }
  return found;
}

/** What the control plane is asked with: it keeps every request. */
export const http =
  (world: FleetSyncWorld) =>
  (request: ControlRequest): Promise<ControlResponse> => {
    controlPlane(world).requests.push(request);
    return Promise.resolve(controlPlane(world).answer);
  };

Given(
  'the secrets provider holds a tailnet-admin credential generated for this scenario',
  (world) => {
    controlPlane(world).credential = `placeholder-admin-${randomUUID()}`;
  }
);

Given('the secrets provider holds no tailnet-admin credential', (world) => {
  controlPlane(world).credential = null;
});

Given(
  'the fleet declares the tailnet control plane:',
  (world, json: string) => {
    const config = parseTailnetConfig(JSON.parse(json));
    expect(config).not.toBeNull();
    controlPlane(world).config = config!;
  }
);

Given(
  'the control plane answers {int} with:',
  (world, status: number, json: string) => {
    controlPlane(world).answer = { status, body: JSON.parse(json) };
  }
);

async function ask(
  world: FleetSyncWorld,
  call: (
    control: NonNullable<Awaited<ReturnType<typeof fleetTailnetControl>>>
  ) => Promise<void>
): Promise<void> {
  const plane = controlPlane(world);
  try {
    const control = await fleetTailnetControl(
      plane.config,
      async (name) => (name === 'tailnet-admin' ? plane.credential : null),
      http(world)
    );
    await call(control!);
  } catch (error) {
    plane.refusal = error as Error;
  }
}

When('a key is created for {string}', async (world, worker: string) => {
  await ask(world, async (control) => {
    controlPlane(world).key = (await control.createAuthKey({ worker })).key;
  });
});

When('the devices tagged {string} are listed', async (world, tag: string) => {
  await ask(world, async (control) => {
    controlPlane(world).devices = await control.listDevices(tag);
  });
});

When('the device {string} is deleted', async (world, id: string) => {
  await ask(world, (control) => control.deleteDevice(id));
});

When(
  'key expiry of the device {string} is disabled',
  async (world, id: string) => {
    await ask(world, (control) => control.disableKeyExpiry(id));
  }
);

const last = (world: FleetSyncWorld): ControlRequest => {
  const { requests } = controlPlane(world);
  expect(requests.length).toBeGreaterThan(0);
  return requests.at(-1)!;
};

const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown> | undefined)?.[key],
      value
    );

Then(
  'the control plane was asked {string} {string}',
  (world, method: string, url: string) => {
    expect(last(world).method).toBe(method as ControlRequest['method']);
    expect(last(world).url).toBe(url);
  }
);

Then('the control plane was asked nothing', (world) => {
  expect(controlPlane(world).requests).toEqual([]);
});

Then('the request carried the credential as a bearer token', (world) => {
  expect(last(world).headers['authorization']).toBe(
    `Bearer ${controlPlane(world).credential}`
  );
});

Then('the request body holds:', (world, table: DataTable) => {
  const body = JSON.parse(last(world).body ?? 'null') as unknown;
  for (const { field, value } of table.hashes())
    expect(String(at(body, field!))).toBe(value!);
});

Then(
  'the key the request asks for expires within {int} minutes',
  (world, minutes: number) => {
    const body = JSON.parse(last(world).body!) as { expiration: string };
    const left = Date.parse(body.expiration) - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(minutes * 60_000);
  }
);

Then('the key it answers is {string}', (world, key: string) => {
  expect(controlPlane(world).refusal).toBeUndefined();
  expect(controlPlane(world).key).toBe(key);
});

Then('the devices listed are:', (world, table: DataTable) => {
  expect(
    controlPlane(world).devices?.map(({ id, name }) => ({ id, name }))
  ).toEqual(table.hashes() as { id: string; name: string }[]);
});

// ── The Tailscale play ───────────────────────────────────────────────────

type Task = Record<string, unknown> & { name?: string };
const plays = new WeakMap<FleetSyncWorld, Task[]>();

When('the Tailscale play of a worker is read', (world) => {
  const [play] = parse(
    readFileSync(join(ROOT, 'ansible/ubuntu/tailscale.yml'), 'utf8')
  ) as { tasks: Task[] }[];
  plays.set(world, play!.tasks);
});

const tasks = (world: FleetSyncWorld): Task[] => plays.get(world)!;
const joinTask = (world: FleetSyncWorld): Task => {
  const found = tasks(world).find((task) => task.name?.startsWith('Join'));
  expect(found).toBeDefined();
  return found!;
};

Then('its join runs only when these hold:', (world, table: DataTable) => {
  expect(joinTask(world)['when']).toEqual(expect.arrayContaining(table.list()));
});

Then(
  'its join passes {string} and the declared worker ID as the hostname',
  (world, argument: string) => {
    const argv = String(
      (joinTask(world)['ansible.builtin.command'] as { argv: string }).argv
    );
    expect(argv).toContain(`'${argument}'`);
    expect(argv).toContain("'--hostname=' ~ tailnet_hostname");
  }
);

Then('its join logs nothing', (world) => {
  expect(joinTask(world)['no_log']).toBe(true);
  expect(joinTask(world)['failed_when']).toBe(false);
});

Then(
  'after the join the key file is removed, whatever the join did',
  (world) => {
    const list = tasks(world);
    const removed = list.findIndex(
      (task) =>
        (task['ansible.builtin.file'] as { path?: string; state?: string })
          ?.path === '/run/devfleet/tailnet-auth-key' &&
        (task['ansible.builtin.file'] as { state?: string }).state === 'absent'
    );
    expect(removed).toBeGreaterThan(list.indexOf(joinTask(world)));
    expect(list[removed]!['when']).toBeUndefined();
  }
);

Then('without a join it still stops with {string}', (world, code: string) => {
  const last = tasks(world).at(-1)!;
  const assert = last['ansible.builtin.assert'] as {
    that: string;
    fail_msg: string;
  };
  expect(assert.fail_msg.startsWith(`${code};`)).toBe(true);
  expect(assert.that).toContain("BackendState == 'Running'");
});

Then('it is refused with {string}', (world, code: string) => {
  expect(controlPlane(world).refusal?.message).toBe(code);
});

Then('{string} appears nowhere in the refusal', (world, sentinel: string) => {
  const refusal = controlPlane(world).refusal;
  expect(refusal).toBeDefined();
  expect(
    JSON.stringify({ ...refusal, message: refusal!.message })
  ).not.toContain(sentinel);
});
