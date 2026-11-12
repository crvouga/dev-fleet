import type { FleetDefinition } from './definition';
import { record } from './config';

/** What a worker opens beyond loopback and the tailnet (docs/ubuntu-sync.md,
 * Exposure). Declared fleet-wide as `worker.exposure` and per worker as
 * `exposure`; a field a worker names replaces the fleet-wide one. Applied by
 * ansible/ubuntu/tasks/firewall.yml and ssh.yml, measured as worker:exposure
 * and worker:public-reachability.
 */
export interface ExposurePolicy {
  /** Break-glass: the SSH port stays open on every interface. */
  publicSsh: boolean;
  /** Opened on every interface; a listener on one is allowed. */
  publicPorts: PublicPort[];
  /** A listener outside the allow-list that no fleet service owns, such as
   * an agent's development server: reported as a warning or a failure. The
   * firewall closes it either way.
   */
  otherListeners: 'warn' | 'fail';
}
export interface PublicPort {
  protocol: 'tcp' | 'udp';
  port: number;
}
export type ExposureDeclaration = Partial<ExposurePolicy>;

/** Nothing public: inbound only over loopback and the tailnet. */
export const DEFAULT_EXPOSURE: ExposurePolicy = {
  publicSsh: false,
  publicPorts: [],
  otherListeners: 'warn',
};

export const EXPOSURE_EXPECTED =
  'publicSsh (true or false), publicPorts (a list of {protocol: tcp or udp, port}, each once) and otherListeners ("warn" or "fail")';

function publicPort(value: unknown): PublicPort | null {
  if (!record(value)) return null;
  const { protocol, port } = value;
  if (Object.keys(value).some((key) => key !== 'protocol' && key !== 'port'))
    return null;
  if (protocol !== 'tcp' && protocol !== 'udp') return null;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)
    return null;
  return { protocol, port: port as number };
}

/** A list of ports, each once; null when it is not one. */
function publicPorts(value: unknown): PublicPort[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const parsed = value.map(publicPort);
  if (parsed.some((entry) => entry === null)) return null;
  const ports = parsed as PublicPort[];
  const keys = ports.map((entry) => `${entry.protocol}/${entry.port}`);
  return new Set(keys).size === keys.length ? ports : null;
}

const FIELDS: Record<string, (value: unknown) => boolean> = {
  publicSsh: (value) => typeof value === 'boolean',
  publicPorts: (value) => publicPorts(value) !== null,
  otherListeners: (value) => value === 'warn' || value === 'fail',
};

/** An exposure declaration, or null when it is not one. */
export function parseExposure(value: unknown): ExposureDeclaration | null {
  if (!record(value)) return null;
  const valid = Object.entries(value).every(
    ([key, field]) => Object.hasOwn(FIELDS, key) && FIELDS[key]!(field)
  );
  return valid ? ({ ...value } as ExposureDeclaration) : null;
}

/** The policy one worker runs under: the default, then the fleet-wide
 * declaration, then the worker's own.
 */
export function effectiveExposure(
  fleetWide: ExposureDeclaration | undefined,
  own: ExposureDeclaration | undefined
): ExposurePolicy {
  return { ...DEFAULT_EXPOSURE, ...fleetWide, ...own };
}

/** What a worker opens and listens on, from the fleet configuration. */
export interface WorkerExposure {
  policy: ExposurePolicy;
  /** The port sshd listens on (network.sshPort; 22 when undeclared). */
  sshPort: number;
  /** The port T3 serves on loopback (network.t3Port; 3773). */
  t3Port: number;
}

export function workerExposure(
  definition: Pick<FleetDefinition, 'worker' | 'workers'>,
  node: string
): WorkerExposure {
  const machine = definition.workers.find((entry) => entry.id === node);
  return {
    policy: effectiveExposure(definition.worker?.exposure, machine?.exposure),
    sshPort: machine?.network?.sshPort ?? 22,
    t3Port: machine?.network?.t3Port ?? 3773,
  };
}
