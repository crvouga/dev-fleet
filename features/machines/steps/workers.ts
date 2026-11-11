import { expect } from 'bun:test';
import { verifyResourceSafety } from '../../../src/platform/resource-verify';
import { auditUbuntu } from '../../../src/platform/ubuntu-audit';
import { verifyUbuntuBoot } from '../../../src/platform/ubuntu-verify';
import type { DataTable } from '../../support/gherkin';
import { machines } from './world';

const { When, Then } = machines;

When(
  'the resource safety of the worker whose home is {string} is measured',
  async (world, home: string) => {
    world.checks = await verifyResourceSafety(home, world.run);
  }
);

When(
  'the boot policy of the worker is measured for the user {string}',
  async (world, user: string) => {
    world.checks = await verifyUbuntuBoot(user, world.run);
  }
);

When('the worker is audited', async (world) => {
  world.audit = await auditUbuntu(world.run);
});

Then('the audit says the worker is not supported', (world) => {
  expect(world.audit?.supported).toBe(false);
});

Then('the audit lists exactly these packages:', (world, table: DataTable) => {
  expect(world.audit?.packages).toEqual(
    Object.fromEntries(
      table.hashes().map((row) => [row['package'], row['version']])
    )
  );
});

Then('the audit does not contain {string}', (world, text: string) => {
  expect(world.audit).toBeDefined();
  expect(JSON.stringify(world.audit)).not.toContain(text);
});
