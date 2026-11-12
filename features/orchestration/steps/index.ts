// Every step of the area registers itself in the one registry.
import './agent-configuration';
import './checkout';
import './cli';
import './common';
import './first-boot';
import './interrupted-packages';
import './fleet-sync';
import './repairs';
import './tailnet-health';
import './worker-bootstrap';

export { OrchestrationWorld, orchestration } from '../support/world';
