import type { FleetDefinition, HubBackups } from '../../../src/definition';
import type { BeszelEvidence } from '../../../src/monitoring/beszel';
import type { AgentEnrollment } from '../../../src/monitoring/enroll';
import type { HubLogin } from '../../../src/monitoring/hub-viewer';
import type { Check } from '../../../src/types';
import { steps } from '../../support/gherkin';
import { CommandWorld, commandSteps } from '../../support/command-steps';
import { EnrollmentHub, ViewerHub } from '../support/hubs';

export class MonitoringWorld extends CommandWorld {
  definition: FleetDefinition | undefined;

  // What the hub's API answers, and what was read from it.
  hubUrl = '';
  answers: { matches: (path: string) => boolean; json: string }[] = [];
  hubError: string | undefined;
  asked: string[] = [];
  now: number | undefined;
  /** The hub backups the fleet configuration declares. */
  declaredBackups: HubBackups | undefined;
  evidence: BeszelEvidence | undefined;
  body = '';
  request: RequestInit | undefined;

  // Enrolling a machine, and the hub's accounts.
  enrollmentHub = new EnrollmentHub();
  userId = '';
  earlier: AgentEnrollment | undefined;
  enrolled: AgentEnrollment | undefined;
  login: HubLogin | undefined;
  viewerHub = new ViewerHub();

  // The hub's route and its public endpoint.
  serve = '';
  route: boolean | Check[] | undefined;
  token: string | null | undefined;

  // The hub and the agents, as playbooks apply them.
  enrollment: AgentEnrollment | undefined;
  playbooks: { playbook: string; variables: unknown }[] = [];
  receipts: string | undefined;
  home = '';
  tailscale: string | null = null;
  account: HubLogin | null = null;
  viewer: Check | undefined;
  backups: Check | undefined;
  workerHome = '';

  // A disposable machine the agent's playbook runs on.
  box = '';
  pid = '';
  changed: number | undefined;
  /** What the last playbook run printed. */
  output = '';
}

export const monitoring = steps<MonitoringWorld>();
commandSteps(monitoring);
