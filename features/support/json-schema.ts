import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Schema = Record<string, unknown>;

/** The part of JSON Schema dev-fleet's output schemas use: type, const,
 * enum, required, properties, items, pattern and $ref to a file beside the
 * schema. Returns where the document does not match, empty when it does.
 */
export function validate(path: string, value: unknown): string[] {
  const schema = JSON.parse(readFileSync(path, 'utf8')) as Schema;
  return check(schema, value, '$', dirname(path));
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
}

function check(
  schema: Schema,
  value: unknown,
  at: string,
  directory: string
): string[] {
  if (typeof schema['$ref'] === 'string')
    return check(
      JSON.parse(
        readFileSync(join(directory, schema['$ref']), 'utf8')
      ) as Schema,
      value,
      at,
      directory
    );
  const errors: string[] = [];
  if ('const' in schema && schema['const'] !== value)
    errors.push(`${at} is not ${JSON.stringify(schema['const'])}`);
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value))
    errors.push(`${at} is not one of ${JSON.stringify(schema['enum'])}`);
  const types = schema['type'];
  if (types !== undefined) {
    const list = Array.isArray(types) ? types : [types];
    if (!list.some((type) => matchesType(String(type), value)))
      return [...errors, `${at} is not of type ${list.join(' or ')}`];
  }
  if (
    typeof schema['pattern'] === 'string' &&
    typeof value === 'string' &&
    !new RegExp(schema['pattern']).test(value)
  )
    errors.push(`${at} does not match ${schema['pattern']}`);
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const name of (schema['required'] as string[] | undefined) ?? [])
      if (!(name in object)) errors.push(`${at}.${name} is missing`);
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const [name, property] of Object.entries(properties))
      if (name in object)
        errors.push(
          ...check(property, object[name], `${at}.${name}`, directory)
        );
  }
  if (Array.isArray(value) && schema['items'])
    value.forEach((item, index) =>
      errors.push(
        ...check(schema['items'] as Schema, item, `${at}[${index}]`, directory)
      )
    );
  return errors;
}
