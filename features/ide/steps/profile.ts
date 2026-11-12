import { expect } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import {
  profileCheck,
  reconcileProfile,
  type ProfileChange,
} from '../../../src/t3/profile';
import { ide, type IdeWorld } from './world';
import { readWith } from './seam';

const { Given, When, Then } = ide;

interface Profile {
  declared: Record<string, unknown>;
  interruptions: number;
  plan: ProfileChange[];
  writtenAt?: number;
}
const profiles = new WeakMap<IdeWorld, Profile>();
const of = (world: IdeWorld): Profile => {
  let value = profiles.get(world);
  if (!value)
    profiles.set(world, (value = { declared: {}, interruptions: 0, plan: [] }));
  return value;
};

const settingsPath = (world: IdeWorld): string =>
  join(world.t3Home, 'userdata/settings.json');
const settings = (world: IdeWorld): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsPath(world), 'utf8')) as Record<
    string,
    unknown
  >;
const save = (world: IdeWorld, value: unknown): void =>
  writeFileSync(settingsPath(world), JSON.stringify(value, null, 2) + '\n');

/** A value as a feature writes it: JSON, or else a plain string. */
const value = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

Given('a T3 home whose settings hold:', (world, text: string) => {
  mkdirSync(join(world.t3Home, 'userdata'), { recursive: true });
  save(world, JSON.parse(text));
});

Given('the fleet declares the T3 profile:', (world, text: string) => {
  of(world).declared = JSON.parse(text) as Record<string, unknown>;
});

const apply = async (world: IdeWorld, preview = false): Promise<void> => {
  const profile = of(world);
  const options = {
    apply: !preview,
    pause: async () => {},
    // T3 writing its own settings between dev-fleet's read and write.
    beforeWrite: async () => {
      if (profile.interruptions <= 0) return;
      profile.interruptions--;
      const current = settings(world);
      save(world, {
        ...current,
        lastOpened: Number(current['lastOpened'] ?? 0) + 1,
      });
    },
  };
  world.checks = [
    await profileCheck(settingsPath(world), profile.declared, options),
  ];
};

Given('the profile has been applied', async (world) => {
  await apply(world);
});

Given(
  'T3 rewrites its settings while dev-fleet merges, {int} time(s)',
  (world, times: number) => {
    of(world).interruptions = times;
  }
);

Given(
  "T3's setting {string} was changed on the machine to {string}",
  (world, key: string, text: string) => {
    save(world, { ...settings(world), [key]: value(text) });
  }
);

When('the profile is applied', async (world) => {
  const before = await reconcileProfile(
    settingsPath(world),
    of(world).declared,
    {
      apply: false,
    }
  );
  // A write replaces the file through a rename: a new inode.
  of(world).writtenAt = statSync(settingsPath(world)).ino;
  await apply(world);
  of(world).plan = before.changes;
});

When('the profile is previewed', async (world) => {
  await apply(world, true);
});

Then('the profile plan is:', (world, table: DataTable) => {
  expect(of(world).plan as { key: string; action: string }[]).toEqual(
    table.hashes().map((row) => ({ key: row['key']!, action: row['action']! }))
  );
});

Then("T3's settings hold:", (world, text: string) => {
  expect(settings(world)).toEqual(JSON.parse(text));
});

Then("T3's setting {string} is:", (world, key: string, text: string) => {
  expect(settings(world)[key]).toEqual(JSON.parse(text));
});

Then("T3's settings have no {string}", (world, key: string) => {
  expect(Object.hasOwn(settings(world), key)).toBe(false);
});

Then("T3's settings file was not rewritten", (world) => {
  expect(statSync(settingsPath(world)).ino).toBe(of(world).writtenAt!);
});

When(
  /^a fleet configuration with the T3 profile (.+) is read$/,
  (world, profile: string) => {
    readWith(world, 't3', { profile: JSON.parse(profile) });
  }
);
