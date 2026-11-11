import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_ROOT, packageInfo } from '../package-info';
import { STATE_ROSTER } from '../state/roster';

export interface Settings {
  workspace: string;
  /** A roster file, or `state:roster` for the roster in the fleet state. */
  config: string;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findUp(start: string, name: string): Promise<string | null> {
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, name))) return join(current, name);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A dev-fleet checkout, as opposed to any other project that has a mise.toml. */
const CHECKOUT_MARKER = 'bootstrap/fleet-manager-run.sh';

/** Where the CLI runs from. A published package is its own workspace, whatever
 * project it is run in; code run from a checkout uses the dev-fleet checkout
 * the command is started in (development).
 */
async function findCheckout(start: string): Promise<string> {
  if (packageInfo().revision) return PACKAGE_ROOT;
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, CHECKOUT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return PACKAGE_ROOT;
    current = parent;
  }
}

export async function resolveSettings(
  overrides: Partial<Settings> = {},
  cwd = process.cwd(),
  env = process.env
): Promise<Settings> {
  const workspace = resolve(
    overrides.workspace ??
      env['PERSONAL_WORKSPACE'] ??
      (await findCheckout(cwd))
  );
  // A roster file is named explicitly; otherwise it is kept in the fleet state.
  const named =
    overrides.config ??
    env['PERSONAL_FLEET_CONFIG'] ??
    (await findUp(cwd, '.fleet.local.json'));
  const config =
    !named || named === STATE_ROSTER ? STATE_ROSTER : resolve(named);
  return { workspace, config };
}
