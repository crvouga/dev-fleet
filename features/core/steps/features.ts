import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import { renderReport, makeReport } from '../../../src/report';
import {
  featuresCheck,
  workerFeatures,
  type WorkerFeatures,
} from '../../../src/worker-features';
import { workerHostChecks } from '../../../src/worker-host-checks';
import { verifyUbuntuBoot } from '../../../src/platform/ubuntu-verify';
import { sessionsCheck } from '../../../src/worker-capacity';
import { threshold, thresholds } from '../../../src/worker-sizing';
import { diskCheck } from '../../../src/machine-health';
import {
  workerSelection,
  workerToolset,
} from '../../../bootstrap/worker-tools';
import type { Check } from '../../../src/types';
import { core, need, root, type CoreWorld } from './world';

/** Declared worker features, the class of a machine and its size: what a
 * worker is built with and which checks apply to it.
 */
const { Given, When, Then } = core;

const mise = Bun.TOML.parse(
  readFileSync(resolve(root, 'mise.toml'), 'utf8')
) as { tools: Record<string, unknown>; vars: Record<string, unknown> };

function reported(world: CoreWorld, checks: Check[]): void {
  world.checks = checks;
  world.outcome = checks;
}

const features = (world: CoreWorld, id: string): WorkerFeatures =>
  workerFeatures(need(world, world.definition, 'a fleet configuration'), id);

// ── Declared features ────────────────────────────────────────────────────

Then(
  /^the worker "([^"]+)" has containers (on|off) and a "(desktop|headless)" session$/,
  (world, id: string, containers: string, session: string) => {
    expect(features(world, id)).toEqual({
      containers: containers === 'on',
      session: session as WorkerFeatures['session'],
    });
  }
);

Then(
  'the worker {string} installs the base tools without {string}',
  (world, id: string, tool: string) => {
    const definition = need(world, world.definition, 'a fleet configuration');
    const base = String(mise.vars['worker_tools']).split(',');
    expect(base).toContain(tool);
    expect(
      Object.keys(
        workerToolset(mise.tools, mise.vars, workerSelection(definition, id))
      )
    ).toEqual(base.filter((name) => name !== tool));
  }
);

// ── What a worker's host is measured against ─────────────────────────────

When(
  /^the host of a worker with the features (\{.*\}) is checked$/,
  async (world, written: string) => {
    const declared = JSON.parse(written) as Partial<WorkerFeatures>;
    reported(
      world,
      await workerHostChecks('dev', world.commands.run, {
        containers: declared.containers ?? true,
        session: declared.session ?? 'desktop',
      })
    );
  }
);

When(
  'the host of a worker whose declared note is {string} is checked',
  async (world, note: string) => {
    reported(
      world,
      await workerHostChecks(
        'dev',
        world.commands.run,
        { containers: true, session: 'desktop' },
        note
      )
    );
  }
);

When('the boot policy of a virtual worker is checked', async (world) => {
  reported(world, await verifyUbuntuBoot('dev', world.commands.run, 'virtual'));
});

When('the boot policy of a physical worker is checked', async (world) => {
  reported(
    world,
    await verifyUbuntuBoot('dev', world.commands.run, 'physical')
  );
});

/** Parts of a feature named in a table: `package docker.io`, `group docker`. */
function parts(table: DataTable): { packages: string[]; groups: string[] } {
  const rows = table.list().filter((row) => row !== '(none)');
  return {
    packages: rows
      .filter((row) => row.startsWith('package '))
      .map((row) => row.slice('package '.length)),
    groups: rows
      .filter((row) => row.startsWith('group '))
      .map((row) => row.slice('group '.length)),
  };
}

const removal = new WeakMap<
  CoreWorld,
  { packages: string[]; groups: string[] }
>();

Given(
  'before the sync a worker without containers held:',
  (world, table: DataTable) => {
    removal.set(world, parts(table));
  }
);

When(
  'after the sync the worker without containers holds:',
  (world, table: DataTable) => {
    reported(world, [
      featuresCheck(
        { containers: false, session: 'desktop' },
        parts(table),
        need(world, removal.get(world), 'what the worker held before')
      ),
    ]);
  }
);

// ── Sizing ───────────────────────────────────────────────────────────────

Then(
  'on a machine with {int} GiB of memory and a {int} GiB disk the lines are, in MiB:',
  (_world, memory: number, disk: number, table: DataTable) => {
    const computed = thresholds({
      memoryMiB: memory * 1024,
      diskMiB: disk * 1024,
    });
    expect(
      Object.fromEntries(
        table
          .hashes()
          .map((row) => [
            row['line'],
            computed[row['line'] as keyof typeof computed],
          ])
      )
    ).toEqual(
      Object.fromEntries(
        table.hashes().map((row) => [row['line'], Number(row['MiB'])])
      )
    );
  }
);

Then(
  'no line is above its declared upper bound on a {int} GiB disk',
  (_world, disk: number) => {
    const policy = JSON.parse(
      readFileSync(resolve(root, 'ansible/ubuntu/policy.json'), 'utf8')
    ) as {
      sizing: {
        thresholds: Record<string, { minMiB: number; maxMiB: number }>;
      };
    };
    for (const [name, line] of Object.entries(policy.sizing.thresholds)) {
      const value = threshold(
        name as Parameters<typeof threshold>[0],
        disk * 1024
      );
      expect(value).toBeLessThanOrEqual(line.maxMiB);
      expect(value).toBeGreaterThanOrEqual(line.minMiB);
    }
  }
);

When(
  'a worker with {int} MiB of memory runs {int} agent sessions',
  (world, memory: number, running: number) => {
    reported(world, [sessionsCheck(memory, running)]);
  }
);

When(
  'a disk of {int} GiB has {int} MiB free',
  (world, disk: number, free: number) => {
    const found = diskCheck(free, disk * 1024)!;
    reported(world, [
      {
        id: `worker:capacity:${found.id}`,
        status: found.severity,
        summary: found.detail,
      },
    ]);
  }
);

// ── Reports ──────────────────────────────────────────────────────────────

Then(
  'the printed report of the worker {string} says:',
  (world, node: string, table: DataTable) => {
    const text = renderReport(
      makeReport('fleet-status', [{ node, checks: world.checks }])
    );
    for (const line of table.list()) expect(text).toContain(line);
  }
);

Then(
  'the JSON report of the worker {string} holds the check {string} as {string}, saying {string}',
  (world, node: string, id: string, status: string, text: string) => {
    const report = JSON.parse(
      JSON.stringify(
        makeReport('fleet-status', [{ node, checks: world.checks }])
      )
    ) as { nodes: { checks: Check[] }[]; summary: Record<string, number> };
    const check = report.nodes[0]!.checks.find((entry) => entry.id === id);
    expect(check?.status).toBe(status as Check['status']);
    expect(check?.summary).toContain(text);
    expect(report.summary['not-applicable']).toBeGreaterThan(0);
  }
);
