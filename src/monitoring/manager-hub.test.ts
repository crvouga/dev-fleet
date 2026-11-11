import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TAILSCALE_APP_CLI,
  convergeManagerHub,
  managerHubPaths,
  tailscaleCommand,
} from './manager-hub';
import { loadDefinition } from '../definition';
import type { Check, CommandResult, Runner } from '../types';

const root = resolve(import.meta.dir, '../..');
const definition = loadDefinition(resolve(root, 'examples/fleet.json'));
const HOST = 'manager-mac-1.tail0a1b2c.ts.net';
const HUB = `https://${HOST}:8443`;
const SECRET = 'never-output-tunnel-token';
const CLI = '/opt/homebrew/bin/tailscale';
const routed = JSON.stringify({
  TCP: { '8443': { HTTPS: true } },
  Web: {
    [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8090' } } },
  },
});
const result = (ok: boolean, stdout = ''): CommandResult => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit',
});

type Handler = (args: readonly string[]) => CommandResult;
interface Fixture {
  host?: string;
  docker?: boolean;
  token?: string | null;
  routedAfterServe?: boolean;
  privateHealthy?: boolean;
}
function fixture(options: Fixture = {}) {
  const calls: string[][] = [];
  const variables: unknown[] = [];
  let served = false;
  const vault = (): CommandResult => {
    const token = options.token === undefined ? SECRET : options.token;
    return result(token !== null, token ?? '');
  };
  const ansible = (args: readonly string[]): CommandResult => {
    variables.push(JSON.parse(readFileSync(args.at(-1)!.slice(1), 'utf8')));
    return result(true);
  };
  const status = (): CommandResult =>
    result(true, served && (options.routedAfterServe ?? true) ? routed : '{}');
  const serve = (args: readonly string[]): CommandResult => {
    served = true;
    return ansible(args);
  };
  const curl = (args: readonly string[]): CommandResult =>
    result(
      args.at(-1)!.startsWith('http://127.0.0.1') ||
        (options.privateHealthy ?? true)
    );
  const routes: [(args: readonly string[]) => boolean, Handler][] = [
    [
      (args) => args[0] === '/usr/sbin/scutil',
      () => result(true, `${options.host ?? 'Manager-Mac'}\n`),
    ],
    [
      (args) => args[0] === 'docker',
      () => result(options.docker ?? true, '29.0.0'),
    ],
    [(args) => args[0] === 'vault', vault],
    [(args) => args.includes('hub-darwin.yml'), ansible],
    [(args) => args.join(' ').endsWith('serve status --json'), status],
    [(args) => args.includes('hub-route-darwin.yml'), serve],
    [(args) => args[0] === 'curl', curl],
  ];
  const run: Runner = async (args) => {
    calls.push([...args]);
    const route = routes.find(([matches]) => matches(args));
    return route ? route[1](args) : result(false);
  };
  return { run, calls, variables };
}
const options = {
  home: '/Users/dev',
  // Unwritable: no receipt is ever recorded, so every call applies in full.
  receipts: '/dev/null/receipts',
  tailscale: CLI,
  account: async () => null,
  viewer: async (): Promise<Check> => ({
    id: 'beszel:public-viewer',
    status: 'pass',
    summary: 'viewer',
  }),
};

test('the manager hub converges locally with a per-user data dir and private route', async () => {
  const { run, calls, variables } = fixture();
  const checks = await convergeManagerHub(root, definition, run, options);
  expect(checks.map((check) => [check.id, check.status])).toEqual([
    ['beszel:hub', 'pass'],
    ['beszel:public-endpoint', 'pass'],
    ['beszel:public-viewer', 'pass'],
  ]);
  expect(variables[0]).toEqual({
    beszel_hub_url: HUB,
    beszel_public_url: 'https://beszel.example.com',
    beszel_auto_login: 'public-viewer@example.com',
    beszel_data_dir: '/Users/dev/Library/Application Support/personal-beszel',
    beszel_tunnel_dir:
      '/Users/dev/Library/Application Support/personal-beszel-tunnel',
    beszel_tunnel_token: SECRET,
  });
  // The route is declared: its playbook publishes it, never this code.
  expect(variables[1]).toEqual({
    beszel_tailscale_cli: CLI,
    beszel_route_port: '8443',
    beszel_route_target: 'http://127.0.0.1:8090',
  });
  expect(calls.some((args) => args.includes('--bg'))).toBe(false);
  expect(calls.some((args) => args[0] === 'sudo')).toBe(false);
  expect(calls.some((args) => args[0] === 'ssh')).toBe(false);
  expect(calls.flat().join(' ')).not.toContain(SECRET);
  expect(JSON.stringify(checks)).not.toContain(SECRET);
  expect(calls).toContainEqual(expect.arrayContaining([`${HUB}/api/health`]));
});

test('the hub refuses to run anywhere but the manager', async () => {
  const { run, calls } = fixture({ host: 'worker-one' });
  const checks = await convergeManagerHub(root, definition, run, options);
  expect(checks[0]?.summary).toBe('BESZEL_NOT_MANAGER');
  expect(checks[0]?.remedy?.action).toContain('runs only on the manager');
  expect(calls).toHaveLength(1);
});

test('Docker Desktop must be running before any hub change', async () => {
  const { run, calls } = fixture({ docker: false });
  const checks = await convergeManagerHub(root, definition, run, options);
  expect(checks[0]?.summary).toBe('BESZEL_DOCKER_DESKTOP_REQUIRED');
  expect(calls.some((args) => args.includes('hub-darwin.yml'))).toBe(false);
  expect(calls.some((args) => args[0] === 'vault')).toBe(false);
});

test('a missing tunnel credential warns without blocking the private hub', async () => {
  const { run, variables } = fixture({ token: null });
  const checks = await convergeManagerHub(root, definition, run, options);
  expect(checks[0]?.status).toBe('pass');
  expect(checks[1]?.summary).toBe('BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE');
  expect(variables[0]).not.toHaveProperty('beszel_tunnel_token');
});

test('route and reachability failures cannot pass readiness', async () => {
  const unobserved = fixture({ routedAfterServe: false });
  expect(
    (await convergeManagerHub(root, definition, unobserved.run, options))[0]
      ?.summary
  ).toBe('BESZEL_PRIVATE_ROUTE_UNVERIFIED');
  const unreachable = fixture({ privateHealthy: false });
  expect(
    (await convergeManagerHub(root, definition, unreachable.run, options))[0]
      ?.summary
  ).toBe('BESZEL_HUB_UNREACHABLE');
  const noCli = fixture();
  expect(
    (
      await convergeManagerHub(root, definition, noCli.run, {
        ...options,
        tailscale: null,
      })
    )[0]?.summary
  ).toBe('BESZEL_TAILSCALE_REQUIRED');
});

test('the macOS Tailscale CLI resolves from PATH, then the app bundle', () => {
  expect(
    tailscaleCommand('/usr/bin:/opt/homebrew/bin', (path) => path === CLI)
  ).toBe(CLI);
  expect(
    tailscaleCommand('/usr/bin', (path) => path === TAILSCALE_APP_CLI)
  ).toBe(TAILSCALE_APP_CLI);
  expect(tailscaleCommand('/usr/bin', () => false)).toBeNull();
  expect(managerHubPaths('/Users/x').data).toBe(
    '/Users/x/Library/Application Support/personal-beszel'
  );
});

test('a fresh hub receives the fleet login so it can create the account itself', async () => {
  const { run, variables } = fixture();
  await convergeManagerHub(root, definition, run, {
    ...options,
    account: async () => ({ identity: 'fleet@example.test', password: 'x' }),
  });
  expect(variables[0]).toMatchObject({
    beszel_fleet_identity: 'fleet@example.test',
    beszel_fleet_password: 'x',
  });
});
