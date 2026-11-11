import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

function assertions(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertions);
    return;
  }
  const object = value as Record<string, unknown>;
  const assertion = object['ansible.builtin.assert'];
  if (assertion && typeof assertion === 'object') {
    const conditions = (assertion as Record<string, unknown>)['that'];
    const items = Array.isArray(conditions) ? conditions : [conditions];
    if (!items.length || !items.every((item) => typeof item === 'string'))
      throw new Error(
        'Ansible assertion conditions must be strings; quote YAML expressions containing colon-space.'
      );
  }
  Object.values(object).forEach(assertions);
}

test('tracked fleet assertions remain strings after YAML parsing', async () => {
  for (const directory of ['ubuntu', 'macos', 'monitoring']) {
    const root = resolve(import.meta.dirname, '../ansible', directory);
    for await (const path of new Bun.Glob('**/*.yml').scan(root))
      assertions(parse(readFileSync(resolve(root, path), 'utf8')));
  }
});
test('rejects YAML mapping accidentally created by a colon inside an assertion', () => {
  const invalid = parse(
    "- ansible.builtin.assert:\n    that:\n      - value.startswith('managed: marker')\n"
  );
  expect(() => assertions(invalid)).toThrow('must be strings');
});

test('ownership checks survive moving the owning package', async () => {
  // A check that names the package directory rejects every machine installed
  // before a move; only the marker text up to the path may be compared.
  for (const directory of ['ubuntu', 'macos', 'monitoring']) {
    const root = resolve(import.meta.dirname, '../ansible', directory);
    for await (const path of new Bun.Glob('**/*.yml').scan(root))
      for (const line of readFileSync(resolve(root, path), 'utf8').split('\n'))
        if (/^\s*-\s*"/.test(line) && line.includes('Managed by personal'))
          expect(line).not.toMatch(/Managed by personal [^'"]*packages\/\w/);
  }
});
