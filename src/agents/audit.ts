import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import type { Platform } from '../platform/types';

/** Content values never leave this module; the audit inventories ownership boundaries. */
export async function auditMachine(platform: Platform) {
  const home = homedir();
  const paths = [
    join(home, '.codex', 'config.toml'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude.json'),
    join(home, '.gemini', 'settings.json'),
    join(platform.opencodeDir(), 'opencode.json'),
    join(home, '.cursor', 'mcp.json'),
    join(home, '.t3', 'userdata', 'settings.json'),
    join(home, '.config', 'cliproxy-fleet', 'settings.json'),
  ];
  const files = [];
  for (const path of paths) files.push(await inspect(path));
  const directories = [];
  for (const tool of ['.codex', '.claude', '.gemini', '.cursor']) {
    for (const kind of ['skills', 'plugins']) {
      const path = join(home, tool, kind);
      const entries = await readdir(path).catch(() => []);
      directories.push({
        tool,
        kind,
        entries: entries.length,
        ownership: 'native/unmanaged; review sources before migration',
      });
    }
  }
  return {
    version: 1,
    files,
    directories,
    environment: Object.keys(process.env).filter((key) =>
      /^(CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|OPENCODE_|T3CODE_|CLIPROXY_|CURSOR_)/.test(
        key
      )
    ),
    warning:
      'Metadata only; values, credentials and runtime state are withheld. This machine is not proof of fleet-wide coverage. Native/project/organization settings may add configuration.',
  };
}

async function inspect(path: string) {
  try {
    const text = await readFile(path, 'utf8');
    const value: unknown = path.endsWith('.toml')
      ? Bun.TOML.parse(text)
      : JSON.parse(text);
    return {
      path,
      present: true,
      fields: fieldNames(value),
      ownership:
        'native/unmanaged; dedicated dev-fleet profiles do not overwrite this file',
    };
  } catch (error) {
    return {
      path,
      present: (error as NodeJS.ErrnoException).code !== 'ENOENT',
      fields: [],
      ownership:
        'missing or unparseable; inspect locally, no raw error retained',
    };
  }
}

export function fieldNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => /^[a-zA-Z_$][a-zA-Z0-9_$-]{0,63}$/.test(key))
    .sort();
}
