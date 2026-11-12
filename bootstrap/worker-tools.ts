import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A worker installs only this declared subset; every version still comes from mise.lock. */
export function workerTools<T>(
  tools: Record<string, T>,
  selected: unknown
): Record<string, T> {
  if (typeof selected === 'string') selected = selected.split(',');
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    new Set(selected).size !== selected.length ||
    !selected.every(
      (key) => typeof key === 'string' && Object.hasOwn(tools, key)
    ) ||
    !['bun', 'node', 'gh', 'python', 'uv', 'docker-cli', 'vault'].every((key) =>
      selected.includes(key)
    )
  )
    throw new Error(
      'Invalid worker tool profile: all required tools need authoritative mise pins.'
    );
  return Object.fromEntries(
    selected.map((key: string) => [key, tools[key]!])
  ) as Record<string, T>;
}

/** Named tool sets a fleet adds to its workers on top of the base set
 * (`worker_tools`). Each is `worker_profile_<name>` under [vars] in
 * mise.toml; every version still comes from mise.lock.
 */
export const TOOL_PROFILES = ['web', 'go', 'rust', 'jvm'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** What a fleet configuration adds to one worker's base tools: profiles and
 * single tools, each already pinned in mise.toml.
 */
export interface ToolSelection {
  profiles: string[];
  tools: string[];
}
export const NO_SELECTION: ToolSelection = { profiles: [], tools: [] };

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The selection a fleet configuration makes for one worker: the fleet-wide
 * `worker.toolProfiles` and `worker.tools`, plus that worker's own
 * `toolProfiles`. Read from the plain document, so the bootstrap needs no
 * fleet code.
 */
export function workerSelection(
  definition: unknown,
  node?: string
): ToolSelection {
  if (!record(definition)) return NO_SELECTION;
  const policy = record(definition['worker']) ? definition['worker'] : {};
  const workers: unknown[] = Array.isArray(definition['workers'])
    ? definition['workers']
    : [];
  const own = workers
    .filter(record)
    .filter((entry) => node !== undefined && entry['id'] === node)
    .flatMap((entry) => list(entry['toolProfiles']));
  return {
    profiles: [...new Set([...list(policy['toolProfiles']), ...own])],
    tools: [...new Set(list(policy['tools']))],
  };
}

/** The selection of the fleet configuration fleet-sync installed on this
 * machine; none when there is no configuration yet.
 */
export function installedSelection(
  node: string | undefined,
  home: string = homedir()
): ToolSelection {
  const path = join(home, '.config/dev-fleet/fleet.json');
  if (!existsSync(path)) return NO_SELECTION;
  try {
    return workerSelection(JSON.parse(readFileSync(path, 'utf8')), node);
  } catch {
    return NO_SELECTION;
  }
}

/** The tools of one worker: the base set, then each selected profile's, then
 * the single tools, in that order and each once. A profile mise.toml does not
 * declare, or a tool it does not pin, is refused.
 */
export function workerToolset<T>(
  tools: Record<string, T>,
  vars: Record<string, unknown>,
  selection: ToolSelection = NO_SELECTION
): Record<string, T> {
  const names = (value: unknown) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : [];
  const base = names(vars['worker_tools']);
  const added = selection.profiles.flatMap((profile) => {
    const declared = vars[`worker_profile_${profile}`];
    if (typeof declared !== 'string' || !declared)
      throw new Error(
        `Unknown worker tool profile "${profile}". Choose from ${TOOL_PROFILES.join(', ')}.`
      );
    return names(declared);
  });
  for (const tool of selection.tools)
    if (!Object.hasOwn(tools, tool))
      throw new Error(
        `The worker tool "${tool}" has no pin in dev-fleet's mise.toml. Ask for it in an issue.`
      );
  return workerTools(tools, [
    ...new Set([...base, ...added, ...selection.tools]),
  ]);
}

/** `--profiles web,go --tools fd` for the doctor and the setup. */
export function selectionArguments(selection: ToolSelection): string[] {
  return [
    ...(selection.profiles.length
      ? ['--profiles', selection.profiles.join(',')]
      : []),
    ...(selection.tools.length ? ['--tools', selection.tools.join(',')] : []),
  ];
}

/** The selection named by `--profiles` and `--tools`. */
export function parseSelectionArguments(argv: string[]): ToolSelection {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0
      ? []
      : (argv[index + 1] ?? '').split(',').filter((item) => item.length > 0);
  };
  return { profiles: value('--profiles'), tools: value('--tools') };
}
