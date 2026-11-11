import { workerTools } from './worker-tools';
/** Read-only toolchain checks; no logins, installations or changes to Docker. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspaceRoot } from './global-config';

type Tool = string | { version: string; lazy?: boolean; os?: string[] };
type Config = {
  tools: Record<string, Tool>;
  vars?: { worker_tools?: unknown };
};
export type Check = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};
export type Runner = (command: string[]) => { ok: boolean; output: string };
const COMMANDS: Record<string, string> = {
  'npm:@yarnpkg/cli-dist': 'yarn',
  'npm:vercel': 'vercel',
  'npm:wrangler': 'wrangler',
  'aqua:anomalyco/opencode': 'opencode',
  'docker-cli': 'docker',
  opentofu: 'tofu',
  ripgrep: 'rg',
  rust: 'rustc',
  'npm:@devcontainers/cli': 'devcontainer',
  'http:grok': 'grok',
  'http:antigravity': 'antigravity',
};
const VERSION_ARGS: Record<string, string[]> = {
  go: ['version'],
  gitleaks: ['version'],
  kubectl: ['version', '--client=true', '--output=json'],
  helm: ['version', '--short'],
};
const run: Runner = (command) => {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    cwd: tmpdir(),
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
};

/** mise's `os` names for the platforms it installs a tool on. */
const MISE_OS: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};
/** Installed on Windows by a native installer (native-aws.ts), not by mise. */
const NATIVE_WINDOWS = new Set(['aws']);

function unavailable(id: string, tool: Tool, platform: string): boolean {
  if (typeof tool === 'string' || !tool.os) return false;
  if (platform === 'win32' && NATIVE_WINDOWS.has(id)) return false;
  return !tool.os.includes(MISE_OS[platform] ?? platform);
}

export function toolChecks(
  tools: Record<string, Tool>,
  execute: Runner = run,
  platform: string = process.platform
): Check[] {
  const checks: Check[] = [];
  for (const [id, tool] of Object.entries(tools)) {
    if (typeof tool !== 'string' && tool.lazy) continue;
    // A tool pinned only for other platforms has no artifact to verify here.
    if (unavailable(id, tool, platform)) continue;
    const version = typeof tool === 'string' ? tool : tool.version;
    const command = COMMANDS[id] ?? id;
    const result = execute([command, ...(VERSION_ARGS[id] ?? ['--version'])]);
    const exact = new RegExp(
      `(?:^|[^0-9])${version.replaceAll('.', '\\.')}($|(?![0-9]|\\.[0-9]))`
    );
    const matches = result.ok && exact.test(result.output);
    checks.push({
      id,
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? version
        : `Expected ${command} ${version}; run dev-fleet tools sync and reopen the shell. Check for competing PATH entries.`,
    });
  }
  for (const command of ['git', 'npm']) {
    const result = execute([command, '--version']);
    checks.push({
      id: command,
      status: result.ok ? 'pass' : 'fail',
      detail: result.ok
        ? result.output
        : `Missing ${command}; rerun the OS bootstrap.`,
    });
  }
  return checks;
}

export function dockerChecks(
  required: boolean,
  execute: Runner = run
): Check[] {
  return [
    ['docker-engine', ['docker', 'info', '--format', '{{.ServerVersion}}']],
    ['docker-compose', ['docker', 'compose', 'version']],
    ['docker-buildx', ['docker', 'buildx', 'version']],
  ].map(([id, command]) => {
    const result = execute(command as string[]);
    return {
      id: id as string,
      status: result.ok ? 'pass' : required ? 'fail' : 'warn',
      detail: result.ok
        ? result.output
        : 'Install/start Docker Desktop or Docker Engine with Compose + Buildx. See docs/machine-setup.md.',
    };
  });
}

export function checkMachine(requireDocker = false, worker = false): Check[] {
  const config = Bun.TOML.parse(
    readFileSync(join(workspaceRoot, 'mise.toml'), 'utf8')
  ) as Config;
  const auth = run(['gh', 'auth', 'status']);
  return [
    ...toolChecks(
      worker
        ? workerTools(config.tools, config.vars?.worker_tools)
        : config.tools
    ),
    ...dockerChecks(requireDocker),
    {
      id: 'github-auth',
      status: auth.ok ? 'pass' : 'warn',
      detail: auth.ok
        ? 'Authenticated'
        : 'Run gh auth login, then gh auth setup-git.',
    },
  ];
}

if (import.meta.main) {
  const checks = checkMachine(
    process.argv.includes('--docker'),
    process.argv.includes('--worker')
  );
  const ok = checks.every((check) => check.status !== 'fail');
  if (process.argv.includes('--json'))
    console.log(JSON.stringify({ ok, checks }, null, 2));
  else
    for (const check of checks)
      console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
  process.exitCode = ok ? 0 : 1;
}
