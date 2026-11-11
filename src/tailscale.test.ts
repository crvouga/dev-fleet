import { expect, test } from 'bun:test';
import { discoverTailnet, parseTailnet } from './tailscale';
import { matchesComputer, matchComputers } from './tailnet-matching';
import { failure, NODE, success } from './test-fixtures';

export function peer(id = 'computer', os = 'macOS', online = true) {
  return {
    ID: id,
    HostName: id,
    DNSName: `${id}.tailnet.ts.net.`,
    OS: os,
    Online: online,
    TailscaleIPs: ['100.64.0.1'],
  };
}
export function inventory() {
  return {
    BackendState: 'Running',
    Health: null,
    Self: peer('manager'),
    Peer: {
      offline: peer('offline', 'linux', false),
      phone: peer('phone', 'iOS'),
      android: peer('android', 'android'),
    },
  };
}

test('includes offline computers and self; excludes only explicit mobile operating systems', () => {
  const tailnet = parseTailnet(inventory());
  expect(tailnet.computers.map((computer) => computer.id)).toEqual([
    'manager',
    'offline',
  ]);
  expect(tailnet.computers[1]?.online).toBe(false);
  expect(tailnet.excludedMobile).toBe(2);
  expect(tailnet.checks[0]?.status).toBe('pass');
  const data = inventory();
  data.Peer.offline.OS = 'new-unknown-os';
  expect(parseTailnet(data).computers).toHaveLength(2);
});

test('coordination problems, logged out daemons, missing CLI and malformed JSON never pass discovery', async () => {
  const data = { ...inventory(), Health: ['private daemon diagnostic'] };
  const warning = parseTailnet(data);
  expect(warning.checks[0]?.status).toBe('fail');
  expect(JSON.stringify(warning)).not.toContain('private daemon diagnostic');
  expect(parseTailnet({ BackendState: 'NeedsLogin' }).checks[0]?.status).toBe(
    'fail'
  );
  for (const result of [
    failure('private-token'),
    success('{'),
    success('{"BackendState":"Running"}'),
  ]) {
    const tailnet = await discoverTailnet(async () => result);
    expect(tailnet.checks[0]?.status).toBe('fail');
    expect(JSON.stringify(tailnet)).not.toContain('private-token');
  }
});

test('rejects injection hosts, invalid addresses, duplicate peers and oversized discovery', () => {
  for (const update of [
    { DNSName: '-oProxyCommand=secret' },
    { TailscaleIPs: ['localhost;command'] },
    { Online: 'yes' },
  ]) {
    const data = inventory();
    Object.assign(data.Self, update);
    expect(() => parseTailnet(data)).toThrow();
  }
  const data = inventory();
  data.Peer.offline.ID = 'manager';
  expect(() => parseTailnet(data)).toThrow();
  expect(() =>
    parseTailnet({
      ...inventory(),
      Peer: Object.fromEntries(
        Array.from({ length: 1025 }, (_, i) => [i, peer(String(i))])
      ),
    })
  ).toThrow();
});

test('matches exact tailnet DNS, short names and addresses without hostname-prefix collisions', async () => {
  const computer = parseTailnet(inventory()).computers[1]!;
  expect(matchesComputer('offline', computer)).toBe(true);
  expect(matchesComputer('OFFLINE.tailnet.ts.net.', computer)).toBe(true);
  expect(matchesComputer('offline-other', computer)).toBe(false);
  const nodes = [
    { ...NODE, ssh: 'alias' },
    { ...NODE, id: 'duplicate', ssh: 'another' },
  ];
  const matches = await matchComputers(nodes, [computer], async (command) => {
    expect(command).toContain('PermitLocalCommand=no');
    return success('hostname offline.tailnet.ts.net\n');
  });
  expect(matches.get(computer.id)).toHaveLength(2);
});
