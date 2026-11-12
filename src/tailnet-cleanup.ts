import type { FleetDefinition, MachineDefinition } from './definition';
import type { SecretsProvider } from './secrets';
import {
  TailnetControlError,
  controlRemedy,
  fleetTailnetControl,
  type ControlHttp,
  type TailnetConfig,
  type TailnetControl,
} from './tailnet-control';
import type { Check } from './types';

/** Removes the tailnet device a replaced or retired worker ran as, so the
 * next machine under its id gets the declared name. Asked through the
 * control plane fleet.json declares (`tailnet`), with the `tailnet-admin`
 * credential; the credential is read when a device is removed, never kept.
 */
export interface TailnetCleanup {
  /** Removes the device `deviceId` that `worker` ran as; a check
   * `tailscale:device` that says whether it is gone.
   */
  removeDevice(worker: MachineDefinition, deviceId: string): Promise<Check>;
}

/** The device left to a person: no control plane is declared, or no
 * credential to ask it with is stored.
 */
export function deviceLeftToPerson(
  worker: MachineDefinition,
  device: string,
  why = 'no tailnet control is configured'
): Check {
  return {
    id: 'tailscale:device',
    status: 'skip',
    summary: `The tailnet device ${device} was not removed: ${why}.`,
    remedy: {
      action: `Remove the device ${device} in the tailnet's admin console, so that a new machine gets the name ${worker.network?.tailscaleName ?? worker.id}. To have it removed by itself, declare tailnet in fleet.json and store the secret tailnet-admin.`,
    },
  };
}

/** The cleanup through the tailnet control plane a fleet declares. */
export function tailnetCleanup(
  config: TailnetConfig,
  secret: SecretsProvider,
  http?: ControlHttp
): TailnetCleanup {
  return {
    async removeDevice(worker, device) {
      let control: TailnetControl | null;
      try {
        control = await fleetTailnetControl(config, secret, http);
      } catch (error) {
        if (
          error instanceof TailnetControlError &&
          error.code === 'TAILNET_ADMIN_REQUIRED'
        )
          return deviceLeftToPerson(
            worker,
            device,
            'the secrets provider holds no tailnet-admin'
          );
        throw error;
      }
      if (!control) return deviceLeftToPerson(worker, device);
      try {
        await control.deleteDevice(device);
      } catch (error) {
        if (!(error instanceof TailnetControlError)) throw error;
        // A device that is already gone is what was asked for.
        if (!(await stillListed(control, config.tag, device)))
          return removed(device);
        return {
          id: 'tailscale:device',
          status: 'warn',
          summary: error.code,
          remedy: {
            action: `${controlRemedy(error.code)} Or remove the device ${device} in the tailnet's admin console.`,
          },
        };
      }
      return removed(device);
    },
  };
}

const removed = (device: string): Check => ({
  id: 'tailscale:device',
  status: 'pass',
  summary: `The tailnet no longer holds the device ${device}.`,
});

async function stillListed(
  control: TailnetControl,
  tag: string,
  device: string
): Promise<boolean> {
  try {
    return (await control.listDevices(tag)).some(
      (entry) => entry.id === device
    );
  } catch {
    return true;
  }
}

/** A device name as the control plane gives it, for a report: one DNS-like
 * name, or nothing. Never anything else the control plane answered.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const label = (name: string): string =>
  name.toLowerCase().replace(/\.$/, '').split('.')[0]!;

/** Devices that carry the fleet's worker tag and are no declared worker
 * (parked ones included) nor a device the roster binds: a machine left over
 * from a rebuild, or one joined by hand. Each is a warning `tailscale:leftover`
 * that names the device by its name only. A fleet without a control plane,
 * or without the credential to ask it, says nothing here.
 */
export async function tailnetLeftovers(
  definition: FleetDefinition,
  control: () => Promise<TailnetControl | null>,
  bound: string[] = []
): Promise<Check[]> {
  const tag = definition.tailnet?.tag;
  if (!tag) return [];
  let devices;
  try {
    const found = await control();
    if (!found) return [];
    devices = await found.listDevices(tag);
  } catch (error) {
    if (!(error instanceof TailnetControlError)) throw error;
    if (error.code === 'TAILNET_ADMIN_REQUIRED') return [];
    return [
      {
        id: 'tailscale:leftover',
        status: 'skip',
        summary: error.code,
        remedy: { action: controlRemedy(error.code) },
      },
    ];
  }
  const declared = new Set(
    [definition.manager, ...definition.workers].flatMap((machine) => [
      machine.id,
      ...(machine.network ? [label(machine.network.tailscaleName)] : []),
    ])
  );
  return devices
    .filter(
      (device) =>
        !bound.includes(device.id) && !declared.has(label(device.name))
    )
    .map((device) => {
      const name = NAME.test(device.name) ? device.name : 'without a name';
      return {
        id: 'tailscale:leftover',
        status: 'warn' as const,
        summary: `The tailnet holds the device ${name}, tagged ${tag}, which is no declared worker.`,
        remedy: {
          action: `If the device ${name} left the fleet, remove it in the tailnet's admin console. If it is a worker, declare it in fleet.json (or its worker record).`,
        },
      };
    });
}

/** Adds the leftover devices to a fleet-status report, as their own
 * `tailnet` entry; nothing when there are none.
 */
export async function appendTailnetLeftovers(
  reports: { node: string; checks: Check[] }[],
  definition: FleetDefinition,
  control: (() => Promise<TailnetControl | null>) | undefined,
  nodes: { tailscaleId?: string }[]
): Promise<void> {
  if (!control) return;
  const checks = await tailnetLeftovers(
    definition,
    control,
    nodes.flatMap((node) => (node.tailscaleId ? [node.tailscaleId] : []))
  );
  if (checks.length) reports.push({ node: 'tailnet', checks });
}
