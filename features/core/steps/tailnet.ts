import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { succeeded } from '../../support/commands';
import { parseConfig } from '../../../src/config';
import { matchComputers, matchesComputer } from '../../../src/tailnet-matching';
import {
  discoverTailnet,
  parseTailnet,
  type Tailnet,
  type TailnetComputer,
} from '../../../src/tailscale';
import {
  attempt,
  core,
  need,
  startsWith,
  valueOf,
  type CoreWorld,
} from './world';

/** What Tailscale says of the machines it sees, in its own field names, and
 * what the manager makes of it.
 */
const { Given, When, Then } = core;

type Fields = Record<string, unknown>;

/** One machine as `tailscale status --json` describes it. */
function machine(row: Record<string, string>, number?: number): Fields {
  const cell = (name: string): string =>
    number === undefined
      ? (row[name] ?? '')
      : (row[name] ?? '').replaceAll('#', String(number));
  return {
    ID: cell('ID'),
    HostName: cell('HostName'),
    DNSName: cell('DNSName'),
    OS: cell('OS'),
    Online: cell('Online') === 'true',
    TailscaleIPs: cell('TailscaleIPs')
      .split(',')
      .map((address) => address.trim()),
  };
}

const status = (world: CoreWorld): Fields =>
  need(world, world.tailscale, 'a status of Tailscale');
const peers = (world: CoreWorld): Record<string, Fields> =>
  status(world)['Peer'] as Record<string, Fields>;

Given(
  'Tailscale is running and lists these machines:',
  (world, table: DataTable) => {
    const rows = table.hashes();
    const self = rows.find((row) => row['machine'] === 'this machine');
    if (!self) throw new Error('One row must describe this machine.');
    world.tailscale = {
      BackendState: 'Running',
      Self: machine(self),
      Peer: Object.fromEntries(
        rows
          .filter((row) => row['machine'] === 'peer')
          .map((row) => [row['ID'], machine(row)])
      ),
    };
    // Asked, Tailscale prints the status as the scenario has it by then.
    world.commands.answer(startsWith('tailscale status'), () =>
      succeeded(JSON.stringify(world.tailscale))
    );
  }
);

Given('Tailscale reports no health problem', (world) => {
  status(world)['Health'] = null;
});

Given(
  'Tailscale reports the health problem {string}',
  (world, text: string) => {
    status(world)['Health'] = [text];
  }
);

Given('the status of Tailscale is:', (world, document: string) => {
  world.tailscale = JSON.parse(document) as Fields;
});

Given(
  /^Tailscale reports the "([^"]+)" of (?:this machine|the peer "([^"]+)") as (.+)$/,
  (world, field: string, peer: string | null, value: string) => {
    const described =
      peer === null ? (status(world)['Self'] as Fields) : peers(world)[peer];
    if (!described) throw new Error(`Tailscale lists no peer ${peer}.`);
    described[field] = valueOf(value);
  }
);

Given(
  'Tailscale lists {int} peers numbered from 0, where # is the number:',
  (world, count: number, table: DataTable) => {
    const row = table.hashes()[0]!;
    status(world)['Peer'] = Object.fromEntries(
      Array.from({ length: count }, (_, number) => [
        number,
        machine(row, number),
      ])
    );
  }
);

function discovered(world: CoreWorld, tailnet: Tailnet): void {
  world.tailnet = tailnet;
  world.outcome = tailnet;
  world.checks = tailnet.checks;
}

When('the manager reads the status of Tailscale', async (world) => {
  await attempt(world, () => discovered(world, parseTailnet(status(world))));
});

When('the manager asks Tailscale for its status', async (world) => {
  discovered(world, await discoverTailnet(world.commands.run));
});

const tailnet = (world: CoreWorld): Tailnet =>
  need(world, world.tailnet, 'a tailnet that was discovered');

function computer(world: CoreWorld, id: string): TailnetComputer {
  const found = tailnet(world).computers.find((entry) => entry.id === id);
  if (!found) throw new Error(`No computer ${id} was found.`);
  return found;
}

Then('these computers are found, in this order:', (world, table: DataTable) => {
  expect(
    tailnet(world).computers.map((entry) => ({
      id: entry.id,
      online: String(entry.online),
    }))
  ).toEqual(table.hashes() as { id: string; online: string }[]);
});

Then('{int} computers are found', (world, count: number) => {
  expect(tailnet(world).computers).toHaveLength(count);
});

Then('{int} mobile devices are left out', (world, count: number) => {
  expect(tailnet(world).excludedMobile).toBe(count);
});

Then(
  /^the host name "([^"]+)" (names|does not name) the computer "([^"]+)"$/,
  (world, host: string, verdict: string, id: string) => {
    expect(matchesComputer(host, computer(world, id))).toBe(
      verdict === 'names'
    );
  }
);

When(
  'the workers of the roster are matched to the computer {string}',
  async (world, id: string) => {
    const { nodes } = parseConfig(need(world, world.roster, 'a roster'));
    world.tailnet = parseTailnet(status(world));
    world.matches = await matchComputers(
      nodes,
      [computer(world, id)],
      world.commands.run
    );
  }
);

Then(
  'the computer {string} is matched by {int} workers',
  (world, id: string, count: number) => {
    expect(need(world, world.matches, 'a match').get(id)).toHaveLength(count);
  }
);
