import { FleetUsageError } from '../errors';
import { record } from '../config';

/** The IDEs dev-fleet supports. The support matrix in the README lists the
 * same; enabling one on the fleet is `ides` in fleet.json, not new code.
 */
export const SUPPORTED_IDES = ['t3'] as const;
export type IdeId = (typeof SUPPORTED_IDES)[number];

/** What `t3` in fleet.json declares for every machine's T3. */
export interface T3Definition {
  /** Top-level T3 settings every machine holds the same: tool servers,
   * projects, selected preferences. A key not named here stays local.
   */
  profile?: Record<string, unknown>;
  /** Models T3 must offer for every account of a tool, by tool. */
  requiredModels?: Record<string, string[]>;
}

const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** Settings another part of dev-fleet owns. */
const RESERVED = ['providerInstances'];

function invalid(detail: string): never {
  throw new FleetUsageError(`Invalid fleet.json: ${detail}`);
}

/** The IDEs a fleet runs: those it names, or T3 alone. */
export const idesOf = (definition: { ides?: readonly IdeId[] }): IdeId[] => [
  ...(definition.ides ?? ['t3']),
];

export function parseIdes(value: unknown): IdeId[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((id) => !SUPPORTED_IDES.includes(id as IdeId))
  )
    invalid(`ides lists each of ${SUPPORTED_IDES.join(', ')} at most once.`);
  return value as IdeId[];
}

export function parseT3(value: unknown): T3Definition {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['profile', 'requiredModels'].includes(key)
    )
  )
    invalid('t3 holds only profile and requiredModels.');
  const result: T3Definition = {};
  if (value['profile'] !== undefined) {
    const profile = value['profile'];
    if (
      !record(profile) ||
      Object.keys(profile).some(
        (key) => !KEY.test(key) || RESERVED.includes(key)
      ) ||
      JSON.stringify(profile).length > 65_536
    )
      invalid(
        't3.profile names top-level T3 settings (not providerInstances) and stays under 64 KiB.'
      );
    result.profile = profile;
  }
  if (value['requiredModels'] !== undefined) {
    const required = value['requiredModels'];
    if (
      !record(required) ||
      Object.entries(required).some(
        ([tool, models]) =>
          !KEY.test(tool) ||
          !Array.isArray(models) ||
          models.some(
            (model) =>
              typeof model !== 'string' ||
              !/^[A-Za-z0-9._:-]{1,128}$/.test(model)
          )
      )
    )
      invalid('t3.requiredModels lists model names by tool.');
    result.requiredModels = required as Record<string, string[]>;
  }
  return result;
}
