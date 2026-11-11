import { readFile } from 'node:fs/promises';
import { bundleProbe } from '../transport';

export async function probeSource(): Promise<string> {
  if (typeof Bun !== 'undefined') return bundleProbe();
  return readFile(new URL('./probe.mjs', import.meta.url), 'utf8');
}
