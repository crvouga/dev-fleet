import { expect, test } from 'bun:test';
import { approvedLocalSource } from './local-source';
import { success, failure } from '../test-fixtures';
import type { Runner } from '../types';

const revision = 'a'.repeat(40);
test('approved local commits use canonical Git objects without fetching or reading dirty working files', async () => {
  const commands: string[][] = [];
  const run: Runner = async (args) => {
    commands.push(args);
    return success(
      args.includes('--show-toplevel')
        ? '/repo\n'
        : args.includes('remote')
          ? 'https://github.com/crvouga/dev-fleet\n'
          : revision + '\n'
    );
  };
  expect(await approvedLocalSource('/repo', revision, run)).toBe('/repo');
  expect(commands).toHaveLength(3);
  expect(
    commands.every(
      (args) =>
        !args.some((arg) => ['fetch', 'checkout', 'reset', 'add'].includes(arg))
    )
  ).toBe(true);
});
test('another repository or a missing/different commit cannot supply deployment source', async () => {
  for (const origin of [
    'https://github.com/other/repo.git',
    'https://github.com/crvouga/dev-fleet.git',
  ]) {
    const run: Runner = async (args) =>
      args.includes('--show-toplevel')
        ? success('/repo')
        : args.includes('remote')
          ? success(origin)
          : failure();
    expect(await approvedLocalSource('/repo', revision, run)).toBeNull();
  }
});
