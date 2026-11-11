/** T3 binaryPath adapter. This file remains in Git; no generated executable copies. */
import { homedir } from 'node:os';
import { currentPlatform } from '../src/platform';
import { agentRoot } from '../src/agents/render';
import { select } from '../src/agents/registry';
import { plan } from '../src/agents/converge';
import { launchProfile } from '../src/agents/launch';
import { AgentConfigurationError } from '../src/agents/errors';
import { pinnedPath } from '../src/agents/toolchain';

const SYNC_HINT =
  'Run devfleet fleet-sync from a terminal to repair this machine.';

export async function runManagedProxy(
  tool: 'codex' | 'opencode' | 'claude' | 'grok' | 'antigravity'
): Promise<void> {
  const args = process.argv.slice(2);
  // Version probes need no credentials; answering them lets T3 report the real
  // launch error instead of "unable to determine version".
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    process.exitCode = await Bun.spawn([tool, ...args], {
      env: { ...process.env, PATH: pinnedPath() },
      stdio: ['inherit', 'inherit', 'inherit'],
    }).exited;
    return;
  }
  try {
    const selection = select(process.env['WS_AGENT_NODE'] ?? '', tool, 'proxy');
    const root = agentRoot(homedir(), currentPlatform().name);
    const result = await plan({ root, selection, revision: 'unverified' });
    if (
      !result.previous ||
      result.previous.fingerprint !== result.fingerprint ||
      result.files.some((file) => file.state !== 'unchanged')
    )
      throw new AgentConfigurationError(
        `The ${tool} proxy profile for node ${selection.node} is missing or out of date.`
      );
    // T3 sets WS_AGENT_ACCOUNT on a provider that is pinned to one account.
    process.exitCode = await launchProfile(
      root,
      selection,
      args,
      process.env['WS_AGENT_ACCOUNT'] || undefined
    );
  } catch (error) {
    // Configuration errors carry curated, secret-free messages; others do not.
    const reason =
      error instanceof AgentConfigurationError
        ? error.message
        : 'Managed provider proxy unavailable.';
    process.stderr.write(`${reason} ${SYNC_HINT}\n`);
    process.exitCode = 1;
  }
}
