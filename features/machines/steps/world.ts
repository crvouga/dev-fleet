import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Enrollment } from '../../../src/machine/state';
import type { PlatformBaseline } from '../../../src/machine/platform';
import type { Platform } from '../../../src/platform';
import type { ReceiptResult } from '../../../src/platform/ansible-receipt';
import type { UbuntuAudit } from '../../../src/platform/ubuntu-audit';
import { steps, type World } from '../../support/gherkin';
import { CommandWorld, commandSteps } from '../../support/command-steps';

/** What Ansible was started with, read while it ran. */
export interface AnsibleRun {
  argument: string;
  path: string;
  input: string | undefined;
  fileMode?: number;
  directoryMode?: number;
  content?: string;
}

export class MachinesWorld extends CommandWorld {
  /** The scenario's temporary directory: a fleet, a state or a run directory. */
  directory = '';

  // T3: its policy, its desktop app, its private route and its workspace link.
  pauses = 0;
  artifact = { path: '', version: '' };
  installs = true;
  staged = false;
  installed = false;
  publishes = true;
  /** Whether the play that publishes the route was asked to. */
  publishAsked = false;
  /** Whether Serve now holds the route. */
  published = false;
  referenced = '';
  before = '';

  // Ansible: one run, and applies recorded by a receipt.
  interruption: string | undefined;
  ansible: AnsibleRun | undefined;
  playbook = '';
  sources = '';
  receipts = '';
  receipt = '';
  verified = true;
  applied: ReceiptResult | undefined;

  // What was measured about a machine.
  audit: UbuntuAudit | undefined;
  adapter: Platform | undefined;
  baseline: PlatformBaseline | undefined;
  environment: PlatformBaseline | undefined;
  size: PlatformBaseline | null | undefined;
  probeRoot: string | undefined;
  probeOutput: string | undefined;
  /** What systemd-detect-virt answers in the stand-in root; nothing when
   * the scenario does not say. */
  hypervisor: string | undefined;
  pins: Record<string, string> | undefined;
  browserPins: Record<string, string> | undefined;
  tailscale: { version: string; keySha256: string } | undefined;

  // The manager: its earlier enrollment, its lock and a local checkout.
  enrollment: Enrollment | null | undefined;
  ran: string | undefined;
  contenders: PromiseSettledResult<string>[] = [];
  /** A sync paused between judging the lock abandoned and reclaiming it. */
  paused: { resume: () => void; sync: Promise<string> } | undefined;
  /** The sync that is running, and how to let it end. */
  running:
    { finish: () => void; sync: Promise<unknown>; owner: string } | undefined;
  source: string | null | undefined;
}

export const machines = steps<MachinesWorld>();
commandSteps(machines);

/** A directory that is removed when the scenario ends. */
export async function temporary(world: World, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  world.defer(() => rm(path, { recursive: true, force: true }));
  return path;
}
