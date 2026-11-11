import { expect, test } from 'bun:test';
import { mergeEnrollment } from '../../src/cli/fleet-sync-enrollment';
import type { FleetNode } from '../../src/types';

const node: FleetNode = {
  id: 'devbox',
  ssh: 'devbox',
  workspace: '/home/dev/dirty-repository',
  runtime: '/opt/bun/bin/bun',
  required: ['codex'],
  bootstrapViaSsh: true,
};
test('resuming initial SSH enrollment binds identity without replacing existing paths or capabilities', () => {
  const discovered = {
    ...node,
    workspace: '/different',
    runtime: '/different/bun',
    required: [],
    tailscaleId: 'stable-device',
  };
  const result = mergeEnrollment([node], [discovered]);
  expect(result).toEqual(
    [{ ...node, bootstrapViaSsh: undefined, tailscaleId: 'stable-device' }].map(
      ({ bootstrapViaSsh: _, ...rest }) => rest
    )
  );
  expect(node.bootstrapViaSsh).toBe(true);
  expect(mergeEnrollment(result, [discovered])).toEqual(result);
});
test('discovery cannot replace an enrolled device identity', () => {
  const existing = { ...node, tailscaleId: 'original' };
  expect(
    mergeEnrollment([existing], [{ ...node, tailscaleId: 'replacement' }])
  ).toEqual([existing]);
});
