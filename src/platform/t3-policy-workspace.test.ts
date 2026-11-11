import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableWorkspace } from './t3-policy';

test('a fleet revision is referenced through a stable current link', async () => {
  const fleet = mkdtempSync(join(tmpdir(), 'fleet-'));
  for (const sha of ['aaa', 'bbb'])
    mkdirSync(join(fleet, 'revisions', sha), { recursive: true });
  const first = await stableWorkspace(join(fleet, 'revisions', 'aaa'));
  expect(first).toBe(join(fleet, 'current'));
  const second = await stableWorkspace(join(fleet, 'revisions', 'bbb'));
  expect(second).toBe(first);
  expect(readlinkSync(second)).toBe(join('revisions', 'bbb'));
  expect(realpathSync(second)).toBe(
    realpathSync(join(fleet, 'revisions', 'bbb'))
  );
});
test('an ordinary checkout is used as-is', async () => {
  expect(await stableWorkspace('/home/me/personal')).toBe('/home/me/personal');
});
