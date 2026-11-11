import { describe, expect, test } from 'bun:test';
import { parseConfig, selectNodes } from './config';
import { NODE } from './test-fixtures';

describe('roster validation', () => {
  test('defaults required capabilities without permitting executable commands', () => {
    expect(
      parseConfig({
        version: 1,
        nodes: [{ id: 'test', ssh: 'host', workspace: '/repo' }],
      }).nodes[0]?.required
    ).toEqual(['github', 'vault', 't3', 'toolchain']);
    expect(
      parseConfig({ version: 1, nodes: [NODE] }).nodes[0]?.required
    ).toEqual([]);
  });
  test.each([
    '-oProxyCommand=evil',
    'user@host',
    'host;evil',
    'host\n',
    '$(evil)',
    'host space',
  ])('rejects SSH options/injection: %s', (ssh) => {
    expect(() =>
      parseConfig({ version: 1, nodes: [{ ...NODE, ssh }] })
    ).toThrow();
  });
  test.each(['relative', '~/repo', '/repo\nsecret', '/repo\0'])(
    'rejects invalid paths: %s',
    (path) => {
      expect(() =>
        parseConfig({ version: 1, nodes: [{ ...NODE, workspace: path }] })
      ).toThrow();
    }
  );
  test('rejects unknown fields, invalid versions, duplicate IDs and missing/large rosters', () => {
    expect(() => parseConfig({ version: 2, nodes: [NODE] })).toThrow();
    expect(() =>
      parseConfig({ version: 1, nodes: [NODE], token: 'never-print-this' })
    ).toThrow();
    expect(() =>
      parseConfig({ version: 1, nodes: [{ ...NODE, command: 'evil' }] })
    ).toThrow();
    expect(() => parseConfig({ version: 1, nodes: [NODE, NODE] })).toThrow();
    expect(() => parseConfig({ version: 1, nodes: [] })).toThrow();
    expect(() =>
      parseConfig({ version: 1, nodes: Array.from({ length: 65 }, () => NODE) })
    ).toThrow();
  });
  test('selects nodes deterministically and fails closed on unknown selections', () => {
    const config = parseConfig({
      version: 1,
      nodes: [NODE, { ...NODE, id: 'other' }],
    });
    expect(selectNodes(config, []).length).toBe(2);
    expect(selectNodes(config, ['other']).map((node) => node.id)).toEqual([
      'other',
    ]);
    expect(() => selectNodes(config, ['typo'])).toThrow();
  });
  test('published schema accepts the example and rejects control characters', async () => {
    const schema = await Bun.file(
      new URL('../schema/roster.schema.json', import.meta.url)
    ).json();
    expect(
      parseConfig(
        await Bun.file(
          new URL('../examples/roster.json', import.meta.url)
        ).json()
      ).nodes.length
    ).toBe(1);
    const pattern = new RegExp(
      schema.properties.nodes.items.properties.workspace.pattern
    );
    expect(pattern.test('/home/name with spaces/repo')).toBe(true);
    expect(pattern.test('/home/name\n')).toBe(false);
  });
});
