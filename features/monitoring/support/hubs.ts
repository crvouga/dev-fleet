import type { HubRequest } from '../../../src/monitoring/enroll';

type Row = Record<string, unknown>;

/** A hub that remembers what it is told, as the one the manager enrolls
 * machines in does: system records and fingerprints, read back as lists.
 */
export class EnrollmentHub {
  info: unknown = {};
  systems: Row[] = [];
  fingerprints: Row[] = [];
  /** How many more times storing a fingerprint fails. */
  failures = 0;
  systemsCreated = 0;
  readonly writes: { path: string; body: object }[] = [];

  readonly request: HubRequest = async (path, body) => {
    if (body) this.writes.push({ path, body });
    if (path.endsWith('/info')) return this.info;
    if (path.includes('/systems/')) {
      if (!body) return { items: this.systems };
      this.systems.push(body as Row);
      this.systemsCreated++;
      return body;
    }
    if (!body) return { items: this.fingerprints };
    if (this.failures > 0) {
      this.failures--;
      throw new Error('injected boundary failure');
    }
    this.fingerprints.push(body as Row);
    return body;
  };
}

/** The hub's user API as the viewer is ensured through it: an admin login,
 * and at most one viewer account that can be listed, created and changed.
 */
export class ViewerHub {
  readonly base = 'http://hub';
  viewer: { id: string; role: string } | null = null;
  acceptsLogin = true;
  readonly calls: { method: string; path: string; body: unknown }[] = [];

  readonly fetcher = (async (url: string, init: RequestInit) => {
    const path = url.replace(this.base, '');
    const method = init.method ?? 'GET';
    const body = init.body
      ? (JSON.parse(init.body as string) as Row)
      : undefined;
    this.calls.push({ method, path, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path.endsWith('/_superusers/auth-with-password'))
      return this.acceptsLogin ? json({ token: 'su' }) : json({}, 400);
    if (method === 'GET')
      return json({ items: this.viewer ? [this.viewer] : [] });
    const role = String(body?.['role']);
    this.viewer =
      method === 'POST'
        ? { id: 'abcdefghijklmno', role }
        : { ...this.viewer!, role };
    return json(this.viewer);
  }) as unknown as typeof fetch;
}
