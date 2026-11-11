import { fieldNames } from './audit';
import { describe, test, expect } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { select, digest, resolveModel } from './registry';
import { render, agentRoot } from './render';
import { convergeAgents, plan, publicPlan } from './converge';
import { safeParents } from './files';

const revision = 'a'.repeat(40);

describe('agent configuration ownership', () => {
  test('audit exposes keys rather than credentials or settings values', () => {
    const names = fieldNames({
      model: 'PRIVATE_SENTINEL',
      apiKey: 'PRIVATE_SENTINEL',
      mcpServers: { token: 'PRIVATE_SENTINEL' },
    });
    expect(names).toEqual(['apiKey', 'mcpServers', 'model']);
    expect(JSON.stringify(names)).not.toContain('PRIVATE_SENTINEL');
  });
  test('separates routes and platform destinations without secret values', () => {
    const proxy = render(select('canary', 'codex', 'proxy'))['config.toml']!;
    expect(proxy).toContain('wire_api = "responses"');
    expect(proxy).toContain('env_key = "CLIPROXY_API_KEY"');
    expect(
      render(select('canary', 'codex', 'direct'))['config.toml']
    ).not.toContain('personal_proxy');
    expect(agentRoot('C:\\Users\\dev', 'windows')).toBe(
      'C:\\Users\\dev\\AppData\\Local\\personal\\agents'
    );
    expect(agentRoot('/home/dev', 'linux')).toBe(
      '/home/dev/.config/personal/agents'
    );
    expect(
      resolveModel('canary', 'codex', 'direct', {
        canary: { codex: { direct: 'reviewed-model' } },
      })
    ).toBe('reviewed-model');
    expect(() => select('../escape', 'codex', 'direct')).toThrow();
    expect(select('node', 'gemini', 'proxy').model).toBe('gemini-3-flash');
    expect(
      render(select('node', 'gemini', 'proxy'))['.gemini/settings.json']
    ).toContain('gateway');
    expect(select('node', 'claude', 'proxy').model).toBe('claude-sonnet-4-6');
    const harness = render(select('node', 'opencode', 'proxy'))[
      'opencode.json'
    ];
    expect(harness).toContain('grok-4.7');
    expect(harness).toContain('devin/muse-wonder-1-0');
  });

  test('preview is read-only; apply is idempotent and detects modifications', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ws-agents-')));
    try {
      const context = {
        root,
        revision,
        selection: select('canary', 'codex', 'proxy'),
      };
      expect((await plan(context)).files[0]?.state).toBe('create');
      await convergeAgents(context);
      const initial = await plan(context);
      const receipt = await readFile(initial.receiptPath, 'utf8');
      await convergeAgents(context);
      expect(await readFile(initial.receiptPath, 'utf8')).toBe(receipt);
      expect((await plan(context)).files[0]?.state).toBe('unchanged');
      await writeFile(initial.files[0]!.path, 'PRIVATE_SENTINEL');
      await expect(convergeAgents(context)).rejects.toThrow('Unmanaged');
      expect(
        JSON.stringify(publicPlan(await plan(context), revision))
      ).not.toContain('PRIVATE_SENTINEL');
      await convergeAgents(context, true);
      expect((await plan(context)).files[0]?.state).toBe('unchanged');
      expect(JSON.parse(receipt).files['config.toml']).toBe(
        digest(initial.files[0]!.content)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects symlink destinations and concurrent application', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ws-conflict-')));
    try {
      await mkdir(join(root, '.apply-lock'));
      await expect(
        convergeAgents({
          root,
          revision,
          selection: select('canary', 'codex', 'proxy'),
        })
      ).rejects.toThrow('Another apply');
      await symlink(root, join(root, 'alias'));
      await expect(safeParents(join(root, 'alias', 'config'))).rejects.toThrow(
        'Symlink conflict'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
