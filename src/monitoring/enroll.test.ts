import { expect, test } from 'bun:test';
import { enrollBeszel, type HubRequest } from './enroll';
const input = {
  node: 'devbox',
  host: 'devbox.example.ts.net',
  hub: 'https://hub.example.ts.net:8443',
  userId: 'abcdefghijklmno',
};
test('interrupted enrollment resumes its system record and preserves token on repeat', async () => {
  let system: object | undefined;
  let fingerprint: object | undefined;
  let interrupted = true;
  let created = 0;
  const request: HubRequest = async (path, body) => {
    if (path.endsWith('/info'))
      return { v: '0.21.1', key: 'ssh-ed25519 fixture' };
    if (path.includes('/systems/')) {
      if (body) {
        system = body;
        created++;
        return body;
      }
      return { items: system ? [system] : [] };
    }
    if (body) {
      if (interrupted) {
        interrupted = false;
        throw new Error('injected boundary failure');
      }
      fingerprint = body;
      return body;
    }
    return { items: fingerprint ? [fingerprint] : [] };
  };
  await expect(enrollBeszel(input, request)).rejects.toThrow();
  const first = await enrollBeszel(input, request);
  const repeat = await enrollBeszel(input, request);
  expect(first).toEqual(repeat);
  expect(created).toBe(1);
});
test('duplicate and conflicting node registrations are never silently adopted', async () => {
  for (const systems of [
    [{ id: input.userId, host: 'other.example.ts.net' }],
    [{}, {}],
  ]) {
    const request: HubRequest = async (path, body) => {
      expect(body).toBeUndefined();
      return path.endsWith('/info')
        ? { v: '0.21.1', key: 'ssh-ed25519 fixture' }
        : { items: systems };
    };
    await expect(enrollBeszel(input, request)).rejects.toThrow();
  }
});
