import { expect } from 'bun:test';
import example from '../../../examples/fleet.json';
import { parseDefinition } from '../../../src/definition';
import {
  blocksPromotion,
  synchronizeManager,
  type ManagerNode,
} from '../../../src/manager-sync';
import type { TailnetComputer } from '../../../src/tailscale';
import type { Status } from '../../../src/types';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  checksIn,
  isSession,
  need,
  orchestration,
  type OrchestrationWorld,
} from '../support/world';

const { Given, When, Then } = orchestration;

/** The example fleet, with the workers the scenario names instead of its own. */
Given(
  'a fleet configuration with these workers:',
  (world, table: DataTable) => {
    world.sync.definition = parseDefinition({
      ...example,
      workers: table.hashes(),
    });
  }
);

Given('the approved revision is {string}', (world, revision: string) => {
  world.sync.revision = revision;
});

Given(
  'every worker answers a fresh SSH session as {string} {string} on {string}, running on a {string}',
  (
    world,
    distribution: string,
    release: string,
    architecture: string,
    environment: string
  ) => {
    world.commands.answer(
      isSession,
      succeeded(
        `${distribution}\n${release}\n${architecture}\n${environment}\n`
      )
    );
  }
);

Given(
  'every worker answers a fresh SSH session as a {string} virtual machine with {int} CPUs, {int} MiB of memory and a {int} MiB root filesystem',
  (world, hypervisor: string, cpus: number, memory: number, disk: number) => {
    world.commands.answer(
      isSession,
      succeeded(
        `ubuntu\n26.04\nx86_64\nmachine\n${hypervisor}\n${cpus}\n${memory}\n${disk}\n`
      )
    );
  }
);

Then(
  'every worker has a check {string} that says {string}',
  (world, id: string, summary: string) => {
    expect(report(world).nodes.length).toBeGreaterThan(0);
    for (const node of report(world).nodes)
      expect(node.checks.find((check) => check.id === id)?.summary).toStartWith(
        summary
      );
  }
);

Given('the manager has no registration for {string}', (world, id: string) => {
  world.nodes = world.nodes.filter((node) => node.id !== id);
});

Given(
  'every registration records the tailscale id {string}',
  (world, tailscaleId: string) => {
    world.nodes = world.nodes.map((node) => ({ ...node, tailscaleId }));
  }
);

Given('every registration authorizes bootstrap over SSH', (world) => {
  world.nodes = world.nodes.map((node) => ({ ...node, bootstrapViaSsh: true }));
});

Given('deploying a worker reports these checks:', (world, table: DataTable) => {
  world.sync.checks = checksIn(table);
});

Given(
  'deploying a worker fails with the error {string}',
  (world, message: string) => {
    world.sync.error = message;
  }
);

/** What `tailscale status --json` prints for the computers of the scenario. */
function tailscaleStatus(computers: TailnetComputer[]): string {
  const peer = (computer: TailnetComputer) => ({
    ID: computer.id,
    HostName: computer.name,
    DNSName: `${computer.dns}.`,
    OS: computer.os,
    TailscaleIPs: computer.ips,
    Online: computer.online,
  });
  return JSON.stringify({
    BackendState: 'Running',
    Self: peer(
      need(
        computers.find((computer) => computer.self),
        'the manager among the computers of the tailnet'
      )
    ),
    Peer: Object.fromEntries(
      computers
        .filter((computer) => !computer.self)
        .map((computer) => [computer.id, peer(computer)])
    ),
  });
}

When(
  /^fleet-sync (applies|previews) the approved revision(?: with "([^"]+)" as its canary)?$/,
  async (world, mode: string, canary: string | undefined) => {
    world.commands.answer(
      (command) => command[0] === 'tailscale',
      succeeded(tailscaleStatus(world.computers))
    );
    const report = await synchronizeManager(
      {
        definition: need(world.sync.definition, 'a fleet configuration'),
        nodes: world.nodes,
        revision: need(world.sync.revision, 'an approved revision'),
        apply: mode === 'applies',
        ...(canary ? { canary } : {}),
        finished: (node) => world.sync.finished.push(node.node),
      },
      world.run,
      async (node, revision) => {
        world.sync.deployed.push({ worker: node.id, revision });
        if (world.sync.error !== undefined) throw new Error(world.sync.error);
        return {
          node: node.id,
          checks: world.sync.checks.map((check) => ({ ...check })),
        };
      }
    );
    world.sync.report = report;
    world.reports = report.nodes;
    world.outcome = report;
  }
);

const report = (world: OrchestrationWorld) =>
  need(world.sync.report, 'a run of fleet-sync');
const worker = (world: OrchestrationWorld, id: string): ManagerNode =>
  need(
    report(world).nodes.find((node) => node.node === id),
    `a report of "${id}"`
  );

Then(
  'the revision was deployed to these workers, in order:',
  (world, table: DataTable) => {
    expect(world.sync.deployed.map((deployment) => deployment.worker)).toEqual(
      table.list()
    );
  }
);

Then('the revision was deployed to no worker', (world) => {
  expect(world.sync.deployed).toEqual([]);
});

Then(
  'every deployment was of the revision {string}',
  (world, revision: string) => {
    expect(world.sync.deployed.length).toBeGreaterThan(0);
    for (const deployment of world.sync.deployed)
      expect(deployment.revision).toBe(revision);
  }
);

Then(
  'the report counts {int} computer(s) on the tailnet that is/are no worker of the fleet',
  (world, count: number) => {
    expect(report(world).candidates).toBe(count);
  }
);

Then(
  'the report shows {string} as {string}',
  (world, id: string, reachability: string) => {
    expect<string>(worker(world, id).reachability).toBe(reachability);
  }
);

Then('the report names {string} as the canary', (world, id: string) => {
  expect(report(world).canary).toBe(id);
});

Then(
  'no check of {string} says {string}',
  (world, id: string, summary: string) => {
    expect(
      worker(world, id).checks.map((check) => check.summary)
    ).not.toContain(summary);
  }
);

Then('{string} holds the approved revision', (world, id: string) => {
  expect(worker(world, id).appliedRevision).toBe(world.sync.revision!);
});

Then(/^the fleet is (ready|not ready)$/, (world, readiness: string) => {
  expect(report(world).ok).toBe(readiness === 'ready');
});

Then('nothing was applied', (world) => {
  expect(report(world).applied).toBe(false);
});

Then(
  'every worker has a check that says {string}',
  (world, summary: string) => {
    expect(report(world).nodes.length).toBeGreaterThan(0);
    expect(
      report(world).nodes.every((node) =>
        node.checks.some((check) => check.summary === summary)
      )
    ).toBe(true);
  }
);

Then('no worker is recorded as having the revision applied', (world) => {
  expect(report(world).nodes.length).toBeGreaterThan(0);
  expect(
    report(world).nodes.every((node) => node.appliedRevision === null)
  ).toBe(true);
});

Then(
  'these workers are recorded as having these revisions applied:',
  (world, table: DataTable) => {
    expect(
      report(world).nodes.map((node) => ({
        worker: node.node,
        revision: node.appliedRevision,
      }))
    ).toEqual(table.hashes() as { worker: string; revision: string }[]);
  }
);

Then(
  'these workers were announced as finished, in order:',
  (world, table: DataTable) => {
    expect(world.sync.finished).toEqual(table.list());
  }
);

// ── Promotion ────────────────────────────────────────────────────────────

When(
  'the canary reports the check {string} as {string} with the summary {string}',
  (world, id: string, status: string, summary: string) => {
    world.verdict = blocksPromotion({ id, status: status as Status, summary });
  }
);

Then(
  /^promotion to the other workers is (allowed|blocked)$/,
  (world, promotion: string) => {
    expect(world.verdict).toBe(promotion === 'blocked');
  }
);
