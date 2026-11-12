import { afterAll } from 'bun:test';
import { runFeatures } from '../support/gherkin';
import { MonitoringWorld, monitoring } from './steps/world';
import { discardAgentBox } from './steps/agent-box';
import './steps/agents';
import './steps/hub';
import './steps/backups';
import './steps/watchdog';

// The agent's playbook on a disposable systemd machine downloads the pinned
// agent: run on request.
//   DEVFLEET_TEST_AGENT_BOX=1 bun test features/monitoring
runFeatures({
  directory: import.meta.dir,
  steps: [monitoring],
  world: () => new MonitoringWorld(),
  // `@slow` scenarios get ten times this: building the machine takes minutes.
  timeoutMs: 30_000,
  skip: (tags) =>
    // Takes a real flock(1), which macOS does not have.
    (tags.includes('@linux') && process.platform !== 'linux') ||
    (tags.includes('@agent-box') && !process.env['DEVFLEET_TEST_AGENT_BOX']),
});

// Removing the machine can take longer than a hook's default five seconds.
afterAll(discardAgentBox, 120_000);
