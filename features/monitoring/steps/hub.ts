import { expect } from 'bun:test';
import {
  beszelReader,
  privateHub,
  verifyBeszel,
  type BeszelRequest,
} from '../../../src/monitoring/beszel';
import { enrollBeszel } from '../../../src/monitoring/enroll';
import {
  inspectRoute,
  publicEndpointCheck,
  tunnelToken,
} from '../../../src/monitoring/hub';
import {
  failure,
  fleetCredentials,
  fleetIdentity,
  publicViewerIdentity,
} from '../../../src/monitoring/hub-access';
import { ensurePublicViewer } from '../../../src/monitoring/hub-viewer';
import type { Check } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { wording } from '../../support/answers';
import { monitoring, type MonitoringWorld } from './world';

const { Given, When, Then } = monitoring;

// ── What the hub knows about a machine ───────────────────────────────────

function answers(world: MonitoringWorld, table: DataTable): void {
  // Described last, tried first: a scenario overrides its background.
  for (const row of table.hashes())
    world.answers.unshift({
      matches: wording(row['request'] ?? ''),
      json: row['answer'] ?? '',
    });
}

Given('the hub {string} answers:', (world, url: string, table: DataTable) => {
  world.hubUrl = url;
  answers(world, table);
});

Given('the hub answers:', answers);

Given(
  'the hub {string} fails every request with the error {string}',
  (world, url: string, message: string) => {
    world.hubUrl = url;
    world.hubError = message;
  }
);

Given("the manager's clock reads {string}", (world, time: string) => {
  world.now = Date.parse(time);
});

const asking =
  (world: MonitoringWorld): BeszelRequest =>
  async (path) => {
    world.asked.push(path);
    if (world.hubError !== undefined) throw new Error(world.hubError);
    const found = world.answers.find((described) => described.matches(path));
    if (!found)
      throw new Error(
        `The scenario does not say what the hub answers: ${path}`
      );
    return JSON.parse(found.json) as unknown;
  };

When(
  "the hub's evidence about the machine {string} is read",
  async (world, machine: string) => {
    world.evidence = await verifyBeszel(
      world.hubUrl,
      machine,
      asking(world),
      world.now
    );
  }
);

const evidence = (world: MonitoringWorld): Check[] => {
  expect(world.evidence?.checks.length).toBeGreaterThan(0);
  return world.evidence!.checks;
};

Then('every check passes', (world) => {
  expect(evidence(world).every((check) => check.status === 'pass')).toBe(true);
});

Then('the newest sample was received at {string}', (world, time: string) => {
  expect(world.evidence?.receivedAt).toBe(time);
});

Then('the evidence does not contain {string}', (world, text: string) => {
  expect(world.evidence).toBeDefined();
  expect(JSON.stringify(world.evidence)).not.toContain(text);
});

Then('exactly these checks fail:', (world, table: DataTable) => {
  expect(
    evidence(world)
      .filter((check) => check.status === 'fail')
      .map((check) => check.id)
  ).toEqual(table.list());
});

Then('the last check fails', (world) => {
  expect(evidence(world).at(-1)?.status).toBe('fail');
});

Then('the summary of the last check is {string}', (world, summary: string) => {
  expect(evidence(world).at(-1)?.summary).toBe(summary);
});

Then('the hub was asked {int} times', (world, count: number) => {
  expect(world.asked.length).toBe(count);
});

Then(
  '{string} is refused as the address of the private hub',
  (_world, address: string) => {
    expect(() => privateHub(address)).toThrow();
  }
);

Given(
  'a hub at {string} that answers every request with {string}',
  (world, url: string, body: string) => {
    world.hubUrl = url;
    world.body = body;
  }
);

When(
  '{string} is read from the hub with the token {string}',
  async (world, path: string, token: string) => {
    const reader = beszelReader(world.hubUrl, token, (async (
      _url: unknown,
      init: RequestInit
    ) => {
      world.request = init;
      return new Response(world.body);
    }) as typeof fetch);
    await reader(path);
  }
);

Then('the request refuses to follow a redirect', (world) => {
  expect(world.request?.redirect).toBe('error');
});

Then('the request names no method', (world) => {
  expect(world.request).toBeDefined();
  expect(world.request?.method).toBeUndefined();
});

// ── Enrolling a machine ──────────────────────────────────────────────────

Given(
  'a hub of release {string} whose key is {string}',
  (world, release: string, key: string) => {
    world.enrollmentHub.info = { v: release, key };
  }
);

Given(
  'the manager is signed in to the hub {string} as the user {string}',
  (world, url: string, user: string) => {
    world.hubUrl = url;
    world.userId = user;
  }
);

Given('the hub fails the first time a fingerprint is stored', (world) => {
  world.enrollmentHub.failures = 1;
});

Given(
  'the hub already lists these system records:',
  (world, records: string) => {
    world.enrollmentHub.systems = JSON.parse(records) as Record<
      string,
      unknown
    >[];
  }
);

const enroll = (world: MonitoringWorld, node: string, host: string) =>
  enrollBeszel(
    { node, host, hub: world.hubUrl, userId: world.userId },
    world.enrollmentHub.request
  );

Given(
  'an enrollment of the machine {string} at {string} was interrupted',
  async (world, node: string, host: string) => {
    await expect(enroll(world, node, host)).rejects.toThrow();
  }
);

// "was enrolled" is the situation; "is enrolled" is what happens, and may be
// refused.
When(
  /^the machine "([^"]+)" at "([^"]+)" (was|is) enrolled$/,
  async (world, node: string, host: string, tense: string) => {
    if (tense === 'was') world.earlier = await enroll(world, node, host);
    else
      await world.attempt(async () => {
        world.enrolled = await enroll(world, node, host);
      });
  }
);

Then('the enrollment fails', (world) => {
  expect(world.enrolled).toBeUndefined();
  expect(world.failure).toBeInstanceOf(Error);
});

Then('the enrollment fails with {string}', (world, message: string) => {
  expect(world.enrolled).toBeUndefined();
  expect((world.failure as Error | undefined)?.message).toBe(message);
});

Then('the enrollment is the same as the one before', (world) => {
  if (world.failure !== undefined) throw world.failure;
  expect(world.earlier).toBeDefined();
  expect(world.earlier!).toEqual(world.enrolled!);
});

Then(
  'the hub was asked to create {int} system record(s) in all',
  (world, count: number) => {
    expect(world.enrollmentHub.systemsCreated).toBe(count);
  }
);

Then('nothing was written to the hub', (world) => {
  expect(world.enrollmentHub.writes).toEqual([]);
});

// ── The hub's accounts ───────────────────────────────────────────────────

Given(
  "the fleet configuration names the manager's hub account {string}",
  (_world, account: string) => {
    expect(fleetIdentity()).toBe(account);
  }
);

When(
  'the secret {string} is read as the hub login',
  async (world, secret: string) => {
    await world.attempt(async () => {
      world.login = fleetCredentials(secret.replaceAll('\\n', '\n'));
    });
  }
);

Then(
  'the login is {string} with the password {string}',
  (world, identity: string, password: string) => {
    if (world.failure !== undefined) throw world.failure;
    expect(world.login!).toEqual({ identity, password });
  }
);

Then(
  'a hub that answers {int} to {string} is reported as {string}',
  (_world, status: number, path: string, code: string) => {
    expect(failure(status, path)).toBe(code);
  }
);

Given(
  'the fleet configuration names the viewer account {string}',
  (_world, account: string) => {
    expect(publicViewerIdentity()).toBe(account);
  }
);

Given(
  'a hub that accepts the fleet admin login and has no viewer account',
  (world) => {
    world.viewerHub.viewer = null;
  }
);

Given(
  'a hub that accepts the fleet admin login and has the viewer account {string} with the role {string}',
  (world, id: string, role: string) => {
    world.viewerHub.viewer = { id, role };
  }
);

Given('a hub that rejects the fleet admin login', (world) => {
  world.viewerHub.acceptsLogin = false;
});

When(
  'the viewer is ensured with the admin login {string} and the password {string}',
  async (world, identity: string, password: string) => {
    world.checks = [
      await ensurePublicViewer(
        { identity, password },
        world.viewerHub.fetcher,
        world.viewerHub.base
      ),
    ];
  }
);

When('the viewer is ensured without an admin login', async (world) => {
  world.checks = [
    await ensurePublicViewer(
      null,
      world.viewerHub.fetcher,
      world.viewerHub.base
    ),
  ];
});

const created = (world: MonitoringWorld): Record<string, unknown> => {
  const create = world.viewerHub.calls.find(
    (call) =>
      call.method === 'POST' &&
      call.body &&
      (call.body as { email?: string }).email
  );
  expect(create).toBeDefined();
  return create!.body as Record<string, unknown>;
};

Then('the hub was asked to create a user with:', (world, table: DataTable) => {
  const expected = Object.fromEntries(
    Object.entries(table.rowsHash()).map(([key, value]) => [
      key,
      value === 'true' ? true : value,
    ])
  );
  expect(created(world)).toMatchObject(expected);
});

Then(
  'the check does not contain the password that user was created with',
  (world) => {
    const password = created(world)['password'];
    expect(typeof password).toBe('string');
    expect(JSON.stringify(world.check)).not.toContain(password as string);
  }
);

Then('the hub was not asked to change a user', (world) => {
  expect(world.viewerHub.calls.some((call) => call.method === 'PATCH')).toBe(
    false
  );
});

Then(
  'the hub was asked to change a user to exactly:',
  (world, table: DataTable) => {
    expect(
      world.viewerHub.calls.find((call) => call.method === 'PATCH')?.body
    ).toEqual(table.rowsHash());
  }
);

// ── The route and the public endpoint ────────────────────────────────────

Given('Tailscale Serve reports:', (world, status: string) => {
  world.serve = status;
});

When('the route to the hub {string} is looked for', (world, hub: string) => {
  world.route = inspectRoute(world.serve, hub);
});

Then('there is no route yet', (world) => {
  expect(world.route).toBe(false);
});

Then('the route is there', (world) => {
  expect(world.route).toBe(true);
});

Then('the route is a conflict', (world) => {
  expect(Array.isArray(world.route)).toBe(true);
});

When(
  "the tunnel credential is read from the fleet's secrets",
  async (world) => {
    world.token = await tunnelToken(world.run);
  }
);

Then('there is no tunnel credential', (world) => {
  expect(world.token).toBeNull();
});

When(
  'the public endpoint is reported without its tunnel credential',
  (world) => {
    world.checks = [publicEndpointCheck(false)];
  }
);
