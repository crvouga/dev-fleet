import { expect } from 'bun:test';
import {
  configureWorkspace,
  decodeReceipt,
  validConfiguration,
  type ConfigurationRequest,
} from '../../../src/configure';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { need, orchestration } from '../support/world';

const { Given, When, Then } = orchestration;

// ── What a request and a receipt must be ─────────────────────────────────

When(
  'a request arrives to configure the revision {string} on the worker {string} for the tool {string} with the profile {string}',
  (world, revision: string, node: string, tool: string, profile: string) => {
    world.verdict = validConfiguration({ revision, node, tool, profile });
  }
);

Then(
  /^the configuration request is (accepted|refused)$/,
  (world, verdict: string) => {
    expect(world.verdict).toBe(verdict === 'accepted');
  }
);

When(
  /^the owner of the agent profile prints (.+) for the revision "([^"]+)"$/,
  (world, output: string, revision: string) => {
    world.configuration.receipt = decodeReceipt(output, revision);
  }
);

Then(
  'the receipt is accepted with the fingerprint {string}',
  (world, fingerprint: string) => {
    expect(world.configuration.receipt).toBe(fingerprint);
  }
);

Then('the receipt is not accepted', (world) => {
  expect(world.configuration.receipt).toBeNull();
});

// ── Configuring a checkout ───────────────────────────────────────────────

Given(
  'this request to configure an agent profile:',
  (world, table: DataTable) => {
    const { revision, worker, tool, profile } = table.rowsHash();
    world.configuration.request = {
      revision: need(revision, 'a revision'),
      node: need(worker, 'a worker'),
      tool: need(tool, 'a tool'),
      profile: need(profile, 'a profile'),
    };
  }
);

const request = (world: {
  configuration: { request?: ConfigurationRequest };
}): ConfigurationRequest =>
  need(world.configuration.request, 'a request to configure');

/** Git is not run: whichever directory it is asked about, it answers that the
 * directory is the top of its own worktree, at the requested revision, with
 * nothing uncommitted.
 */
Given(
  'git reports every directory it is asked about as a clean worktree at the requested revision',
  (world) => {
    world.commands.answer(
      (command) => command[0] === 'git',
      (command, options) => {
        if (command.includes('--show-toplevel'))
          return succeeded(options?.cwd ?? '');
        if (command.includes('--porcelain')) return succeeded('');
        return succeeded(request(world).revision);
      }
    );
  }
);

Given(
  'git reports the uncommitted change {string}',
  (world, change: string) => {
    world.commands.answer(
      (command) => command.includes('--porcelain'),
      succeeded(change)
    );
  }
);

When(
  /^the (bootstrapped )?checkout(?: "([^"]+)")? is configured(?:, with "([^"]+)" as an additional tool)?$/,
  async (
    world,
    bootstrapped: string | undefined,
    path: string | undefined,
    additional: string | undefined
  ) => {
    const root = path ?? need(world.root, 'a directory');
    world.checks = bootstrapped
      ? await configureWorkspace(root, request(world), world.run, {
          additionalTools: additional ? [additional] : [],
          bootstrappedDeployment: true,
        })
      : await configureWorkspace(root, request(world), world.run);
    world.outcome = world.checks;
  }
);
