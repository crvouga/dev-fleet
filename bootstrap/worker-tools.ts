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
