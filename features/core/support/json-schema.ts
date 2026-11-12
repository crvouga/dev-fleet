/** A JSON Schema (draft 2020-12) checker for the keywords
 * schema/fleet.schema.json uses, so the schema an editor checks fleet.json
 * with can be compared with the parser. A keyword it does not know fails
 * loudly instead of being ignored.
 */
type Schema = Record<string, unknown>;

const KNOWN = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'pattern',
  'format',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'oneOf',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function conforms(schema: Schema, value: unknown): boolean {
  for (const key of Object.keys(schema))
    if (!KNOWN.has(key)) throw new Error(`Unsupported schema keyword ${key}.`);
  if (schema['type'] !== undefined) {
    const actual = typeOf(value);
    const wanted = schema['type'];
    const matches =
      actual === wanted || (wanted === 'number' && actual === 'integer');
    if (!matches) return false;
  }
  if (
    'const' in schema &&
    JSON.stringify(schema['const']) !== JSON.stringify(value)
  )
    return false;
  if (
    Array.isArray(schema['enum']) &&
    !schema['enum'].some(
      (option) => JSON.stringify(option) === JSON.stringify(value)
    )
  )
    return false;
  if (typeof value === 'string') {
    if (
      typeof schema['pattern'] === 'string' &&
      !new RegExp(schema['pattern'], 'u').test(value)
    )
      return false;
    if (schema['format'] === 'email' && !EMAIL.test(value)) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum'])
      return false;
    if (typeof schema['maximum'] === 'number' && value > schema['maximum'])
      return false;
  }
  if (Array.isArray(value)) {
    if (
      typeof schema['minItems'] === 'number' &&
      value.length < schema['minItems']
    )
      return false;
    if (
      typeof schema['maxItems'] === 'number' &&
      value.length > schema['maxItems']
    )
      return false;
    if (
      schema['uniqueItems'] === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      return false;
    if (
      schema['items'] &&
      !value.every((item) => conforms(schema['items'] as Schema, item))
    )
      return false;
  }
  if (typeOf(value) === 'object') {
    const fields = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const required = (schema['required'] ?? []) as string[];
    if (required.some((key) => !(key in fields))) return false;
    for (const [key, item] of Object.entries(fields)) {
      if (properties[key]) {
        if (!conforms(properties[key], item)) return false;
      } else if (schema['additionalProperties'] === false) return false;
    }
  }
  if (Array.isArray(schema['oneOf'])) {
    const matching = (schema['oneOf'] as Schema[]).filter((option) =>
      conforms(option, value)
    );
    if (matching.length !== 1) return false;
  }
  return true;
}
